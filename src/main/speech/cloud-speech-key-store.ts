import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  CLOUD_SPEECH_PROVIDERS,
  getCloudSpeechProvider,
  isWellFormedCloudSpeechApiKey,
  MALFORMED_CLOUD_SPEECH_API_KEY_MESSAGE,
  type CloudSpeechKeyStatus,
  type CloudSpeechProviderId
} from '../../shared/cloud-speech-providers'
import { readCredentialFileProtection } from '../credential-file-protection'
import { beginCloudSpeechKeyChange } from './cloud-speech-key-change-fence'

const cachedKeys = new Map<CloudSpeechProviderId, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getTokenBaseName(providerId: CloudSpeechProviderId): string {
  // Why: OpenAI keys saved before multi-provider support live under the original name.
  return providerId === 'openai' ? 'openai-speech-token' : `speech-${providerId}-token`
}

function getKeyPath(providerId: CloudSpeechProviderId): string {
  return join(getOrcaDir(), `${getTokenBaseName(providerId)}.enc`)
}

function getHintPath(providerId: CloudSpeechProviderId): string {
  return join(getOrcaDir(), `${getTokenBaseName(providerId)}.hint`)
}

function formatKeyHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`
}

function writeKeyHint(providerId: CloudSpeechProviderId, apiKey: string): void {
  try {
    writeFileSync(getHintPath(providerId), formatKeyHint(apiKey), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn('[speech] could not write API key hint', { providerId, error })
  }
}

function readLegacyJsonCiphertext(providerId: CloudSpeechProviderId): string | null {
  const keyPath = getKeyPath(providerId)
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(keyPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && 'encryptedKeyBase64' in parsed) {
      const value = parsed.encryptedKeyBase64
      return typeof value === 'string' && value !== '' ? value : null
    }
    return null
  } catch {
    return null
  }
}

export function hasCloudSpeechApiKey(providerId: CloudSpeechProviderId): boolean {
  // Why: status checks run on startup and every list; existence avoids a keychain-prompting decrypt.
  return existsSync(getKeyPath(providerId))
}

/** Last four characters of the saved key for recognition, read without decrypting. */
export function getCloudSpeechApiKeyHint(providerId: CloudSpeechProviderId): string | null {
  if (!hasCloudSpeechApiKey(providerId)) {
    return null
  }
  try {
    const hint = readFileSync(getHintPath(providerId), 'utf8').trim()
    return hint || null
  } catch {
    return null
  }
}

/** How the stored key sits on disk, or null when none is stored. */
export function getCloudSpeechApiKeyProtection(
  providerId: CloudSpeechProviderId
): SecretAtRestProtection | null {
  // The legacy JSON wrapper only ever held base64 ciphertext, so it is sealed by shape.
  if (readLegacyJsonCiphertext(providerId)) {
    return 'sealed'
  }
  return readCredentialFileProtection(getKeyPath(providerId))
}

export function saveCloudSpeechApiKey(providerId: CloudSpeechProviderId, apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error(`${getCloudSpeechProvider(providerId).label} API key is required`)
  }
  if (!isWellFormedCloudSpeechApiKey(trimmed)) {
    throw new Error(MALFORMED_CLOUD_SPEECH_API_KEY_MESSAGE)
  }
  beginCloudSpeechKeyChange(providerId)
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(getKeyPath(providerId), getSecretStore().encryptString(trimmed), { mode: 0o600 })
  } else {
    console.warn(`[speech] secret encryption unavailable — storing ${providerId} key in plaintext`)
    writeFileSync(getKeyPath(providerId), trimmed, { encoding: 'utf8', mode: 0o600 })
  }
  cachedKeys.set(providerId, trimmed)
  writeKeyHint(providerId, trimmed)
}

export function readCloudSpeechApiKey(providerId: CloudSpeechProviderId): string {
  const cached = cachedKeys.get(providerId)
  if (cached !== undefined) {
    return cached
  }
  const label = getCloudSpeechProvider(providerId).label
  const keyPath = getKeyPath(providerId)
  if (!existsSync(keyPath)) {
    throw new Error(`${label} API key is not configured`)
  }
  let apiKey: string
  try {
    const legacyCiphertext = readLegacyJsonCiphertext(providerId)
    if (legacyCiphertext) {
      apiKey = getSecretStore().decryptString(Buffer.from(legacyCiphertext, 'base64'))
    } else {
      const raw = readFileSync(keyPath)
      apiKey = getSecretStore().isEncryptionAvailable()
        ? getSecretStore().decryptString(raw)
        : raw.toString('utf8')
    }
  } catch {
    throw new Error(`${label} API key could not be decrypted`)
  }
  cachedKeys.set(providerId, apiKey)
  if (getCloudSpeechApiKeyHint(providerId) === null) {
    // Why: keys saved before hints existed get one the first time they are decrypted anyway.
    writeKeyHint(providerId, apiKey)
  }
  return apiKey
}

export function clearCloudSpeechApiKey(providerId: CloudSpeechProviderId): void {
  beginCloudSpeechKeyChange(providerId)
  cachedKeys.delete(providerId)
  rmSync(getKeyPath(providerId), { force: true })
  rmSync(getHintPath(providerId), { force: true })
}

export function getCloudSpeechKeyStatus(providerId: CloudSpeechProviderId): CloudSpeechKeyStatus {
  const configured = hasCloudSpeechApiKey(providerId)
  return {
    providerId,
    configured,
    hint: configured ? getCloudSpeechApiKeyHint(providerId) : null,
    protection: configured ? getCloudSpeechApiKeyProtection(providerId) : null
  }
}

export function getAllCloudSpeechKeyStatuses(): CloudSpeechKeyStatus[] {
  return CLOUD_SPEECH_PROVIDERS.map((provider) => getCloudSpeechKeyStatus(provider.id))
}
