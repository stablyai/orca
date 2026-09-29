import { getSecretStore } from '../../shared/secret-store'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type SpeechApiKeyStore = {
  has(): boolean
  save(apiKey: string): void
  read(): string
  clear(): void
}

function readLegacyEncryptedKey(raw: Buffer): Buffer | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'encryptedKeyBase64' in parsed &&
      typeof parsed.encryptedKeyBase64 === 'string' &&
      parsed.encryptedKeyBase64 !== ''
    ) {
      return Buffer.from(parsed.encryptedKeyBase64, 'base64')
    }
  } catch {
    // Existing stores also contain raw encrypted bytes or plaintext.
  }
  return null
}

export function createSpeechApiKeyStore(
  providerLabel: string,
  tokenFile: string
): SpeechApiKeyStore {
  let cachedKey: string | null = null
  const getKeyPath = (): string => join(homedir(), '.orca', tokenFile)

  return {
    has(): boolean {
      // Settings must not decrypt secrets and trigger keychain prompts on startup.
      return existsSync(getKeyPath())
    },
    save(apiKey: string): void {
      const trimmed = apiKey.trim()
      if (!trimmed) {
        throw new Error(`${providerLabel} API key is required`)
      }
      mkdirSync(join(homedir(), '.orca'), { recursive: true })
      const secretStore = getSecretStore()
      const encrypted = secretStore.isEncryptionAvailable()
      if (!encrypted) {
        console.warn(
          `[speech] secret encryption unavailable — storing ${providerLabel} speech key in plaintext`
        )
      }
      const keyPath = getKeyPath()
      const content = encrypted ? secretStore.encryptString(trimmed) : trimmed
      // Replacements must also repair permissions on an existing secret file.
      if (existsSync(keyPath)) {
        chmodSync(keyPath, 0o600)
      }
      writeFileSync(keyPath, content, { mode: 0o600 })
      cachedKey = trimmed
    },
    read(): string {
      if (cachedKey !== null) {
        return cachedKey
      }
      if (!existsSync(getKeyPath())) {
        throw new Error(`${providerLabel} API key is not configured`)
      }
      try {
        const raw = readFileSync(getKeyPath())
        const legacyKey = readLegacyEncryptedKey(raw)
        const secretStore = getSecretStore()
        if (legacyKey) {
          cachedKey = secretStore.decryptString(legacyKey)
        } else {
          cachedKey = secretStore.isEncryptionAvailable()
            ? secretStore.decryptString(raw)
            : raw.toString('utf8')
        }
        return cachedKey
      } catch {
        throw new Error(`${providerLabel} API key could not be decrypted`)
      }
    },
    clear(): void {
      cachedKey = null
      rmSync(getKeyPath(), { force: true })
    }
  }
}
