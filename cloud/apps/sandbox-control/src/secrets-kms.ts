// Google Cloud KMS unwrap of the secret store's KEKs (SECRETS_KEK_SOURCE=kms; off by default).
// The Worker then holds no plaintext KEK in its config: it holds each KEK encrypted by a KMS key
// (SECRETS_KEK_WRAPPED) and a service account that may only decrypt with that key. keyringFor
// (secrets.ts) unwraps once per isolate and keeps the imported keys in memory.
// Each wrapped KEK is bound to its key id through KMS additional authenticated data, so a blob
// deployed under the wrong id fails to unwrap instead of sealing rows under a mislabelled key.
// Nothing from a KMS or token response is logged or put in an error: only a reason and a status.
import { SignJWT, importPKCS8 } from 'jose'
import { z } from 'zod'

export type SecretsKmsReason =
  /** SECRETS_KEK_SOURCE=kms but a KMS setting is missing or malformed. */
  | 'config'
  /** Google refused the service account or its permission on the key (401/403). */
  | 'denied'
  /** KMS rejected the wrapped KEK: wrong key, wrong KEK id, or a corrupted blob (400/404). */
  | 'invalid'
  /** KMS or the token endpoint could not be reached, timed out or answered 5xx. */
  | 'unavailable'

/** The secret store cannot get its keys right now. Callers answer 503; they never fall back to another key. */
export class SecretsKmsError extends Error {
  constructor(
    readonly reason: SecretsKmsReason,
    readonly status?: number
  ) {
    super(`secrets_kms_${reason}`)
    this.name = 'SecretsKmsError'
  }
}

const KEY_NAME = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/
// Fixed endpoints: the service-account file's own token_uri is not trusted.
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const KMS_URL = 'https://cloudkms.googleapis.com/v1'
const SCOPE = 'https://www.googleapis.com/auth/cloudkms'
const TIMEOUT_MS = 5000
const ATTEMPTS = 2

const ServiceAccount = z.looseObject({ client_email: z.string().min(3).max(320), private_key: z.string().min(100) })
const TokenResponse = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().positive().optional() })
const DecryptResponse = z.looseObject({ plaintext: z.string().min(1) })

/** The AAD a KEK is wrapped with (`gcloud kms encrypt --additional-authenticated-data-file`). */
export function kekWrapAad(kekId: string): string {
  return `orca-secrets-kek:${kekId}`
}

export type KekUnwrapper = (wrapped: string, kekId: string) => Promise<string>

/**
 * Returns `unwrap(wrapped, kekId)`: the base64 KEK inside a base64 KMS ciphertext. Throws
 * SecretsKmsError; a 5xx or network failure is retried once.
 */
export function createKekUnwrapper(config: { keyName: string; serviceAccountJson: string; fetch?: typeof fetch; now?: () => number }): KekUnwrapper {
  const doFetch = config.fetch ?? fetch
  const now = config.now ?? Date.now
  if (!KEY_NAME.test(config.keyName)) {
    throw new SecretsKmsError('config')
  }
  let account: z.infer<typeof ServiceAccount>
  try {
    account = ServiceAccount.parse(JSON.parse(config.serviceAccountJson))
  } catch {
    // The parse error could quote the credential; it is dropped.
    throw new SecretsKmsError('config')
  }
  let signingKey: CryptoKey | null = null
  let token: { value: string; expiresAt: number } | null = null

  async function send(url: string, init: RequestInit): Promise<Response> {
    let failure = new SecretsKmsError('unavailable')
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let response: Response
      try {
        response = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch {
        continue
      }
      if (response.ok) {
        return response
      }
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 403) {
        throw new SecretsKmsError('denied', response.status)
      }
      if (response.status < 500 && response.status !== 429) {
        throw new SecretsKmsError('invalid', response.status)
      }
      failure = new SecretsKmsError('unavailable', response.status)
    }
    throw failure
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > now() + 60_000) {
      return token.value
    }
    try {
      signingKey ??= await importPKCS8(account.private_key, 'RS256')
    } catch {
      throw new SecretsKmsError('config')
    }
    const iat = Math.floor(now() / 1000) - 30
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600)
      .sign(signingKey)
    let response: Response
    try {
      response = await send(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
      })
    } catch (error) {
      // Google answers a bad or disabled service account with 400 invalid_grant: that is a refusal, not a bad KEK.
      throw error instanceof SecretsKmsError && error.reason === 'invalid' ? new SecretsKmsError('denied', error.status) : error
    }
    const parsed = TokenResponse.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new SecretsKmsError('unavailable')
    }
    token = { value: parsed.data.access_token, expiresAt: now() + (parsed.data.expires_in ?? 3600) * 1000 }
    return token.value
  }

  return async (wrapped, kekId) => {
    const response = await send(`${KMS_URL}/${config.keyName}:decrypt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext: wrapped, additionalAuthenticatedData: btoa(kekWrapAad(kekId)) })
    })
    const parsed = DecryptResponse.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new SecretsKmsError('unavailable')
    }
    return parsed.data.plaintext
  }
}
