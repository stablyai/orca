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
  return value.trim().replace(/\/+$/, '')
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
    cachedConfig = { baseUrl, model }
    return cachedConfig
  } catch {
    return null
  }
}

export function hasCustomSttEndpoint(): boolean {
  return readCustomSttEndpointConfig() !== null
}

export function saveCustomSttEndpointConfig(config: CustomSttEndpointConfig): void {
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
  if (!model) {
    throw new Error('Endpoint model is required')
  }
  ensureOrcaDir()
  writeFileSync(getEndpointPath(), JSON.stringify({ baseUrl, model }, null, 2), { mode: 0o600 })
  cachedConfig = { baseUrl, model }
}

export function clearCustomSttEndpointConfig(): void {
  cachedConfig = null
  rmSync(getEndpointPath(), { force: true })
  clearCustomSttEndpointApiKey()
}

export function hasCustomSttEndpointApiKey(): boolean {
  return existsSync(getEndpointTokenPath())
}

export function saveCustomSttEndpointApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('API key is required')
  }
  ensureOrcaDir()
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(getEndpointTokenPath(), getSecretStore().encryptString(trimmed), { mode: 0o600 })
    cachedApiKey = trimmed
    return
  }

  console.warn('[speech] secret encryption unavailable — storing custom STT token in plaintext')
  writeFileSync(getEndpointTokenPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedApiKey = trimmed
}

/** Returns the configured bearer token, or null when the endpoint is unauthenticated. */
export function readCustomSttEndpointApiKey(): string | null {
  if (cachedApiKey !== null) {
    return cachedApiKey
  }
  const path = getEndpointTokenPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    cachedApiKey = getSecretStore().isEncryptionAvailable()
      ? getSecretStore().decryptString(raw)
      : raw.toString('utf8')
    return cachedApiKey
  } catch {
    throw new Error('Custom STT endpoint API key could not be decrypted')
  }
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
