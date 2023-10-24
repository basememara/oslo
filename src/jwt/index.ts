import { ECDSA, HMAC, RSASSAPKCS1v1_5, RSASSAPSS } from "../crypto/index.js";
import { decodeBase64url, encodeBase64url } from "../encoding/index.js";
import { isWithinExpirationDate } from "../index.js";

import type { TimeSpan } from "../index.js";

export type JWTAlgorithm =
	| "HS256"
	| "HS384"
	| "HS512"
	| "RS256"
	| "RS384"
	| "RS512"
	| "ES256"
	| "ES384"
	| "ES512"
	| "PS256"
	| "PS384"
	| "PS512";

export async function createJWT(
	algorithm: JWTAlgorithm,
	payload: Record<any, any>,
	key: ArrayBufferLike,
	options?: {
		headers?: Record<any, any>;
		expiresIn?: TimeSpan;
		issuer?: string;
		subject?: string;
		audience?: string;
		notBefore?: Date;
		includeIssuedTimestamp?: boolean;
		jwtId?: string;
	}
): Promise<string> {
	const headers: JWTHeader = {
		alg: algorithm,
		typ: "JWT"
	};
	const payloadWithClaims: JWTPayload = {
		...payload,
		aud: options?.audience,
		iss: options?.issuer,
		sub: options?.subject,
		jti: options?.jwtId
	};
	if (options?.expiresIn !== undefined) {
		payloadWithClaims.exp = Math.floor(Date.now() / 1000) + options.expiresIn.seconds();
	}
	if (options?.notBefore !== undefined) {
		payloadWithClaims.nbf = Math.floor(options.notBefore.getTime() / 1000);
	}
	if (options?.includeIssuedTimestamp === true) {
		payloadWithClaims.iat = Math.floor(Date.now() / 1000);
	}
	const textEncoder = new TextEncoder();
	const headerPart = encodeBase64url(textEncoder.encode(JSON.stringify(headers)));
	const payloadPart = encodeBase64url(textEncoder.encode(JSON.stringify(payloadWithClaims)));
	const signatureBody = textEncoder.encode([headerPart, payloadPart].join("."));
	const signature = await getAlgorithm(algorithm)!.sign(key, signatureBody);
	const signaturePart = encodeBase64url(signature);
	return [signatureBody, signaturePart].join(".");
}

export async function validateJWT(
	algorithm: JWTAlgorithm,
	key: ArrayBufferLike,
	jwt: string | JWT
): Promise<JWT> {
	const parsedJWT = typeof jwt === "string" ? parseJWT(jwt) : jwt;
	if (!parsedJWT) {
		throw new Error("Invalid JWT");
	}
	if (parsedJWT.algorithm !== algorithm) {
		throw new Error("Invalid algorithm");
	}
	if (parsedJWT.expiresAt && !isWithinExpirationDate(parsedJWT.expiresAt)) {
		throw new Error("Expired JWT");
	}
	if (parsedJWT.notBefore && parsedJWT.notBefore.getTime() < Date.now()) {
		throw new Error("Inactive JWT");
	}
	const signature = decodeBase64url(parsedJWT.parts[2]);
	const data = new TextEncoder().encode(parsedJWT.parts[0] + "." + parsedJWT.parts[1]);
	const validSignature = await getAlgorithm(parsedJWT.algorithm).verify(key, signature, data);
	if (!validSignature) {
		throw new Error("Invalid signature");
	}
	return parsedJWT;
}

function getJWTParts(jwt: string): [header: string, payload: string, signature: string] | null {
	const jwtParts = jwt.split(".");
	if (jwtParts.length !== 3) {
		return null;
	}
	return jwtParts as [string, string, string];
}

export function parseJWT(jwt: string): JWT | null {
	const jwtParts = getJWTParts(jwt);
	if (!jwtParts) {
		return null;
	}
	const textDecoder = new TextDecoder();
	const rawHeader = decodeBase64url(jwtParts[0]);
	const rawPayload = decodeBase64url(jwtParts[1]);
	const header: unknown = JSON.parse(textDecoder.decode(rawHeader));
	if (typeof header !== "object" || header === null) {
		return null;
	}
	if (!("typ" in header) || !("alg" in header)) {
		return null;
	}
	if (!isValidAlgorithm(header.alg) || header.typ !== "JWT") {
		return null;
	}
	const payload: unknown = JSON.parse(textDecoder.decode(rawPayload));
	if (typeof payload !== "object" || payload === null) {
		return null;
	}
	const properties: JWTProperties = {
		algorithm: header.alg,
		expiresAt: null,
		subject: null,
		issuedAt: null,
		issuer: null,
		jwtId: null,
		audience: null,
		notBefore: null
	};
	if ("exp" in payload) {
		if (typeof payload.exp !== "number") {
			return null;
		}
		properties.expiresAt = new Date(payload.exp * 1000);
	}
	if ("iss" in payload) {
		if (typeof payload.iss !== "string") {
			return null;
		}
		properties.issuer = payload.iss;
	}
	if ("sub" in payload) {
		if (typeof payload.sub !== "string") {
			return null;
		}
		properties.subject = payload.sub;
	}
	if ("aud" in payload) {
		if (typeof payload.aud !== "string") {
			return null;
		}
		properties.audience = payload.aud;
	}
	if ("nbf" in payload) {
		if (typeof payload.nbf !== "number") {
			return null;
		}
		properties.notBefore = new Date(payload.nbf * 1000);
	}
	if ("iat" in payload) {
		if (typeof payload.iat !== "number") {
			return null;
		}
		properties.issuedAt = new Date(payload.iat * 1000);
	}
	if ("jti" in payload) {
		if (typeof payload.jti !== "string") {
			return null;
		}
		properties.jwtId = payload.jti;
	}
	return {
		value: jwt,
		header: {
			...header,
			typ: "JWT",
			alg: header.alg
		},
		payload: {
			...payload
		},
		parts: jwtParts,
		...properties
	};
}

interface JWTProperties {
	algorithm: JWTAlgorithm;
	expiresAt: Date | null;
	issuer: string | null;
	subject: string | null;
	audience: string | null;
	notBefore: Date | null;
	issuedAt: Date | null;
	jwtId: string | null;
}

export interface JWT extends JWTProperties {
	value: string;
	header: JWTHeader;
	payload: JWTPayload;
	parts: [header: string, payload: string, signature: string];
}

function getAlgorithm(algorithm: JWTAlgorithm): ECDSA | HMAC | RSASSAPKCS1v1_5 | RSASSAPSS {
	if (algorithm === "ES256" || algorithm === "ES384" || algorithm === "ES512") {
		return new ECDSA(ecdsaDictionary[algorithm].hash, ecdsaDictionary[algorithm].curve);
	}
	if (algorithm === "HS256" || algorithm === "HS384" || algorithm === "HS512") {
		return new HMAC(hmacDictionary[algorithm]);
	}
	if (algorithm === "RS256" || algorithm === "RS384" || algorithm === "RS512") {
		return new RSASSAPKCS1v1_5(rsassapkcs1v1_5Dictionary[algorithm]);
	}
	if (algorithm === "PS256" || algorithm === "PS384" || algorithm === "PS512") {
		return new RSASSAPSS(rsassapssDictionary[algorithm]);
	}
	throw new TypeError("Invalid algorithm");
}

function isValidAlgorithm(maybeValidAlgorithm: unknown): maybeValidAlgorithm is JWTAlgorithm {
	if (typeof maybeValidAlgorithm !== "string") return false;
	return [
		"HS256",
		"HS384",
		"HS512",
		"RS256",
		"RS384",
		"RS512",
		"ES256",
		"ES384",
		"ES512",
		"PS256",
		"PS384",
		"PS512"
	].includes(maybeValidAlgorithm);
}

interface JWTHeader {
	typ: "JWT";
	alg: JWTAlgorithm;
}

interface JWTPayload {
	exp?: number;
	iss?: string;
	aud?: string;
	jti?: string;
	nbf?: number;
	sub?: string;
	iat?: number;
	[claim: string]: unknown;
}

const ecdsaDictionary = {
	ES256: {
		hash: "SHA-256",
		curve: "P-256"
	},
	ES384: {
		hash: "SHA-384",
		curve: "P-384"
	},
	ES512: {
		hash: "SHA-512",
		curve: "P-521"
	}
} as const;

const hmacDictionary = {
	HS256: "SHA-256",
	HS384: "SHA-384",
	HS512: "SHA-512"
} as const;

const rsassapkcs1v1_5Dictionary = {
	RS256: "SHA-256",
	RS384: "SHA-384",
	RS512: "SHA-512"
} as const;

const rsassapssDictionary = {
	PS256: "SHA-256",
	PS384: "SHA-384",
	PS512: "SHA-512"
} as const;