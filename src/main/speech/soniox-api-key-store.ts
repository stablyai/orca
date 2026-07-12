import { safeStorage } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SONIOX_SPEECH_TOKEN_FILE = 'soniox-speech-token.enc'
// Why: a leading encoding byte distinguishes encrypted vs plaintext on disk so a
// later safeStorage availability flip cannot treat ciphertext as a UTF-8 key.
const KEY_ENCODING_PLAINTEXT = 0x00
const KEY_ENCODING_ENCRYPTED = 0x01

let cachedSonioxSpeechApiKey: string | null = null

function getKeyPath(): string {
  return join(homedir(), '.orca', SONIOX_SPEECH_TOKEN_FILE)
}

function enforceOwnerOnlyPermissions(): void {
  if (process.platform !== 'win32') {
    // Why: writeFile's mode does not repair a permissive existing key file.
    chmodSync(getKeyPath(), 0o600)
  }
}

function writePrefixedKey(encoding: number, payload: Buffer): void {
  writeFileSync(getKeyPath(), Buffer.concat([Buffer.from([encoding]), payload]), { mode: 0o600 })
  enforceOwnerOnlyPermissions()
}

function decodeStoredKey(raw: Buffer): string {
  if (raw.length === 0) {
    throw new Error('Soniox API key could not be decrypted')
  }

  if (raw[0] === KEY_ENCODING_ENCRYPTED) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encrypted key cannot be decrypted — safeStorage unavailable')
    }
    return safeStorage.decryptString(raw.subarray(1))
  }

  if (raw[0] === KEY_ENCODING_PLAINTEXT) {
    return raw.subarray(1).toString('utf8')
  }

  // Why: keys written before the encoding prefix still need a best-effort read.
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
}

export function hasSonioxSpeechApiKey(): boolean {
  // Why: readiness checks run during startup; existence avoids decrypting
  // safeStorage and triggering a macOS keychain prompt before Soniox is used.
  return existsSync(getKeyPath())
}

export function saveSonioxSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Soniox API key is required')
  }
  mkdirSync(join(homedir(), '.orca'), { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    writePrefixedKey(KEY_ENCODING_ENCRYPTED, safeStorage.encryptString(trimmed))
  } else {
    console.warn(
      '[speech] safeStorage encryption unavailable — storing Soniox speech key in plaintext'
    )
    writePrefixedKey(KEY_ENCODING_PLAINTEXT, Buffer.from(trimmed, 'utf8'))
  }
  cachedSonioxSpeechApiKey = trimmed
}

export function readSonioxSpeechApiKey(): string {
  if (cachedSonioxSpeechApiKey !== null) {
    return cachedSonioxSpeechApiKey
  }
  const path = getKeyPath()
  if (!existsSync(path)) {
    throw new Error('Soniox API key is not configured')
  }
  try {
    cachedSonioxSpeechApiKey = decodeStoredKey(readFileSync(path))
    return cachedSonioxSpeechApiKey
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Encrypted key cannot be decrypted — safeStorage unavailable'
    ) {
      throw error
    }
    throw new Error('Soniox API key could not be decrypted')
  }
}

export function clearSonioxSpeechApiKey(): void {
  cachedSonioxSpeechApiKey = null
  rmSync(getKeyPath(), { force: true })
}
