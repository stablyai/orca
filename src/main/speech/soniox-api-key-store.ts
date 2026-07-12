import { safeStorage } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SONIOX_SPEECH_TOKEN_FILE = 'soniox-speech-token.enc'
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
    writeFileSync(getKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    enforceOwnerOnlyPermissions()
  } else {
    console.warn(
      '[speech] safeStorage encryption unavailable — storing Soniox speech key in plaintext'
    )
    writeFileSync(getKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
    enforceOwnerOnlyPermissions()
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
    const raw = readFileSync(path)
    cachedSonioxSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedSonioxSpeechApiKey
  } catch {
    throw new Error('Soniox API key could not be decrypted')
  }
}

export function clearSonioxSpeechApiKey(): void {
  cachedSonioxSpeechApiKey = null
  rmSync(getKeyPath(), { force: true })
}
