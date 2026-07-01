import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredSarvamKey = {
  encryptedKeyBase64: string
}

const SARVAM_SPEECH_TOKEN_FILE = 'sarvam-speech-token.enc'
let cachedSarvamSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getSarvamKeyPath(): string {
  return join(getOrcaDir(), SARVAM_SPEECH_TOKEN_FILE)
}

function readLegacyJsonStoredSarvamKey(): StoredSarvamKey | null {
  const keyPath = getSarvamKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredSarvamKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasSarvamSpeechApiKey(): boolean {
  // Why: Settings and model-state refresh call this on startup; checking file
  // existence avoids decrypting safeStorage and triggering macOS keychain prompts.
  return existsSync(getSarvamKeyPath())
}

export function saveSarvamSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Sarvam API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getSarvamKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedSarvamSpeechApiKey = trimmed
    return
  }

  console.warn(
    '[speech] safeStorage encryption unavailable — storing Sarvam speech key in plaintext'
  )
  writeFileSync(getSarvamKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedSarvamSpeechApiKey = trimmed
}

export function readSarvamSpeechApiKey(): string {
  if (cachedSarvamSpeechApiKey !== null) {
    return cachedSarvamSpeechApiKey
  }

  const keyPath = getSarvamKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('Sarvam API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    const legacyJson = readLegacyJsonStoredSarvamKey()
    if (legacyJson) {
      cachedSarvamSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedSarvamSpeechApiKey
    }
    cachedSarvamSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedSarvamSpeechApiKey
  } catch {
    throw new Error('Sarvam API key could not be decrypted')
  }
}

export function clearSarvamSpeechApiKey(): void {
  cachedSarvamSpeechApiKey = null
  rmSync(getSarvamKeyPath(), { force: true })
}
