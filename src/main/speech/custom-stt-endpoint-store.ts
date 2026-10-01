import { getSecretStore } from '../../shared/secret-store'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Persistence for a user-configured OpenAI-compatible transcription endpoint.
 *
 * Why a dedicated file and not `VoiceSettings`: `ModelManager.getModelState` and
 * `stt-session-start` need the endpoint without a settings-store handle, exactly the
 * way the OpenAI key store is read today. Base URL and model name are not secrets, so
 * they live in a plain JSON file; the optional bearer token is sealed like every other
 * credential.
 */

export type CustomSttEndpointConfig = {
  /** Base URL up to and including the API version, e.g. `http://127.0.0.1:8090/v1`. */
  baseUrl: string
  /** Model id sent in the multipart `model` field, e.g. `large-v3`. */
  model: string
  /**
   * Optional ISO-639 language hint sent in the multipart `language` field
   * (e.g. `en`, `zh`, `yue`). Empty means let the server auto-detect.
   */
  language: string
}

const ENDPOINT_FILE = 'custom-stt-endpoint.json'
const ENDPOINT_TOKEN_FILE = 'custom-stt-token.enc'

let cachedConfig: CustomSttEndpointConfig | null = null
let cachedApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getEndpointPath(): string {
  return join(getOrcaDir(), ENDPOINT_FILE)
}

function getEndpointTokenPath(): string {
  return join(getOrcaDir(), ENDPOINT_TOKEN_FILE)
}

export function normalizeCustomSttBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  // Why: strip a query/fragment defensively for values read back from disk; new
  // saves reject them outright. Without this, appending the path produces a bad URL.
  try {
    const parsed = new URL(trimmed)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return trimmed
  }
}

export function readCustomSttEndpointConfig(): CustomSttEndpointConfig | null {
  if (cachedConfig) {
    return cachedConfig
  }
  const path = getEndpointPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CustomSttEndpointConfig>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.model !== 'string') {
      return null
    }
    const baseUrl = normalizeCustomSttBaseUrl(parsed.baseUrl)
    const model = parsed.model.trim()
    if (!baseUrl || !model) {
      return null
    }
    const language = typeof parsed.language === 'string' ? parsed.language.trim() : ''
    cachedConfig = { baseUrl, model, language }
    return cachedConfig
  } catch {
    return null
  }
}

export function hasCustomSttEndpoint(): boolean {
  return readCustomSttEndpointConfig() !== null
}

export function saveCustomSttEndpointConfig(
  config: Omit<CustomSttEndpointConfig, 'language'> & { language?: string }
): void {
  const baseUrl = normalizeCustomSttBaseUrl(config.baseUrl)
  const model = config.model.trim()
  if (!baseUrl) {
    throw new Error('Endpoint base URL is required')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Endpoint base URL is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Endpoint base URL must use http or https')
  }
  // Why: a query or fragment would be swallowed when the transcription path is
  // appended (`http://h/v1?x=1` + `/audio/transcriptions` is malformed), so reject
  // them rather than silently POSTing to the wrong place.
  if (parsed.search || parsed.hash) {
    throw new Error('Endpoint base URL must not include a query string or fragment')
  }
  if (!model) {
    throw new Error('Endpoint model is required')
  }
  const language = typeof config.language === 'string' ? config.language.trim() : ''
  ensureOrcaDir()
  const stored: CustomSttEndpointConfig = { baseUrl, model, language }
  writeFileSync(getEndpointPath(), JSON.stringify(stored, null, 2), { mode: 0o600 })
  cachedConfig = stored
}

export function clearCustomSttEndpointConfig(): void {
  cachedConfig = null
  rmSync(getEndpointPath(), { force: true })
  clearCustomSttEndpointApiKey()
}

/**
 * A bearer token is bound to the base URL it was saved for. Why: without a binding,
 * editing the base URL and leaving the key field blank would reuse the old token and
 * send it to the new host — a credential meant for one server leaking to another.
 */
type StoredToken = {
  baseUrl: string
  sealed: string
}

function readStoredToken(): StoredToken | null {
  const path = getEndpointTokenPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredToken>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.sealed !== 'string') {
      return null
    }
    return { baseUrl: normalizeCustomSttBaseUrl(parsed.baseUrl), sealed: parsed.sealed }
  } catch {
    return null
  }
}

function decryptSealedToken(sealed: string): string {
  if (!getSecretStore().isEncryptionAvailable()) {
    return sealed
  }
  try {
    return getSecretStore().decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    throw new Error('Custom STT endpoint API key could not be decrypted')
  }
}

export function hasCustomSttEndpointApiKey(): boolean {
  return readStoredToken() !== null
}

export function saveCustomSttEndpointApiKey(apiKey: string, baseUrl?: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('API key is required')
  }
  const boundUrl = normalizeCustomSttBaseUrl(
    baseUrl ?? readCustomSttEndpointConfig()?.baseUrl ?? ''
  )
  if (!boundUrl) {
    throw new Error('Endpoint base URL is required before saving an API key')
  }
  ensureOrcaDir()
  const encrypted = getSecretStore().isEncryptionAvailable()
  if (!encrypted) {
    console.warn('[speech] secret encryption unavailable — storing custom STT token in plaintext')
  }
  const sealed = encrypted ? getSecretStore().encryptString(trimmed).toString('base64') : trimmed
  writeFileSync(
    getEndpointTokenPath(),
    JSON.stringify({ baseUrl: boundUrl, sealed } satisfies StoredToken, null, 2),
    { mode: 0o600 }
  )
  cachedApiKey = trimmed
}

/**
 * Resolve the bearer token for a request to `baseUrl`, honouring an explicit draft.
 * The draft wins; otherwise the saved token is used only when it was saved for this
 * exact base URL. A token stored for a different host is never sent.
 */
export function resolveCustomSttApiKeyFor(
  baseUrl: string,
  draftKey?: string | null
): string | null {
  const trimmedDraft = draftKey?.trim()
  if (trimmedDraft) {
    return trimmedDraft
  }
  const stored = readStoredToken()
  if (!stored) {
    return null
  }
  return normalizeCustomSttBaseUrl(baseUrl) === stored.baseUrl
    ? decryptSealedToken(stored.sealed)
    : null
}

/** Returns the token for the currently configured endpoint, or null. */
export function readCustomSttEndpointApiKey(): string | null {
  if (cachedApiKey !== null) {
    return cachedApiKey
  }
  return resolveCustomSttApiKeyFor(readCustomSttEndpointConfig()?.baseUrl ?? '')
}

export function clearCustomSttEndpointApiKey(): void {
  cachedApiKey = null
  rmSync(getEndpointTokenPath(), { force: true })
}

/**
 * Resolve the POST target for the custom endpoint. A base URL that already names the
 * transcription path is used verbatim; anything else gets `/audio/transcriptions`
 * appended, so both `http://host:8090/v1` and the full URL work.
 */
export function resolveCustomSttTranscriptionUrl(baseUrl: string): string {
  const normalized = normalizeCustomSttBaseUrl(baseUrl)
  return normalized.endsWith('/audio/transcriptions')
    ? normalized
    : `${normalized}/audio/transcriptions`
}
