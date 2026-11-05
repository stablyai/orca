const MAX_CREDENTIAL_BYTES = 64 * 1024

function invalidCredential(): Error {
  return new Error('Antigravity credentials could not be decoded.')
}

function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw invalidCredential()
  }
  return text
}

export function decodeAntigravityKeychainValue(value: string): string {
  if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) {
    throw invalidCredential()
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('go-keyring-base64:')) {
    const encoded = trimmed.slice('go-keyring-base64:'.length)
    const bytes = Buffer.from(encoded, 'base64')
    if (!encoded || bytes.toString('base64') !== encoded) {
      throw invalidCredential()
    }
    return decodeUtf8(bytes)
  }
  if (trimmed.startsWith('go-keyring-encoded:')) {
    const encoded = trimmed.slice('go-keyring-encoded:'.length)
    if (!/^(?:[\da-f]{2})+$/i.test(encoded)) {
      throw invalidCredential()
    }
    return decodeUtf8(Buffer.from(encoded, 'hex'))
  }
  return trimmed
}

export function encodeAntigravityKeychainValue(contents: string): string {
  if (Buffer.byteLength(contents) > MAX_CREDENTIAL_BYTES) {
    throw invalidCredential()
  }
  return `go-keyring-base64:${Buffer.from(contents, 'utf8').toString('base64')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type AntigravityCredentialIdentity = {
  issuer: 'https://accounts.google.com'
  subject: string
  email: string | null
}

export function readGoogleIdentityClaims(claims: unknown): AntigravityCredentialIdentity | null {
  if (!isRecord(claims) || typeof claims.sub !== 'string' || !claims.sub.trim()) {
    return null
  }
  return {
    issuer: 'https://accounts.google.com',
    subject: claims.sub,
    email:
      claims.email_verified === true && typeof claims.email === 'string' && claims.email.trim()
        ? claims.email
        : null
  }
}

// Unverified claims label local accounts; they never authorize operations.
function readIdentity(idToken: unknown): AntigravityCredentialIdentity | null {
  if (typeof idToken !== 'string') {
    return null
  }
  const parts = idToken.split('.')
  if (parts.length !== 3 || !/^[\w-]+$/.test(parts[1])) {
    return null
  }
  try {
    const claims: unknown = JSON.parse(decodeUtf8(Buffer.from(parts[1], 'base64url')))
    return isRecord(claims) &&
      ['accounts.google.com', 'https://accounts.google.com'].includes(String(claims.iss))
      ? readGoogleIdentityClaims(claims)
      : null
  } catch {
    return null
  }
}

export type AntigravityNativeCredential = {
  contents: string
  authMethod: string
  identity: AntigravityCredentialIdentity | null
  accessToken: string
  refreshToken: string | null
}

export function projectAntigravityNativeCredential(
  contents: string,
  token: { authMethod: string; accessToken: string; refreshToken: string | null; idToken: unknown }
): AntigravityNativeCredential {
  if (Buffer.byteLength(contents) > MAX_CREDENTIAL_BYTES || !token.accessToken.trim()) {
    throw invalidCredential()
  }
  return {
    contents,
    authMethod: token.authMethod,
    identity: readIdentity(token.idToken),
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || null
  }
}

export function parseAntigravityNativeCredential(contents: string): AntigravityNativeCredential {
  if (Buffer.byteLength(contents) > MAX_CREDENTIAL_BYTES) {
    throw invalidCredential()
  }
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw invalidCredential()
  }
  if (!isRecord(value)) {
    throw invalidCredential()
  }
  // agy's legacy OAuth grants retain an empty auth method when rewritten as StoredToken.
  const legacy = !('token' in value) && !('auth_method' in value)
  const token = legacy ? value : value.token
  const authMethod = value.auth_method ?? ''
  if (
    typeof authMethod !== 'string' ||
    !isRecord(token) ||
    typeof token.access_token !== 'string' ||
    !token.access_token.trim()
  ) {
    throw invalidCredential()
  }
  return projectAntigravityNativeCredential(contents, {
    authMethod,
    idToken: value.id_token ?? token.id_token,
    accessToken: token.access_token,
    refreshToken:
      typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : null
  })
}
