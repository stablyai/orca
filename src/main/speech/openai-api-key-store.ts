import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

function readLegacyJsonStoredOpenAiKey(): StoredOpenAiKey | null {
  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredOpenAiKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasOpenAiSpeechApiKey(): boolean {
  // Why: Settings and model-state refresh call this on startup; checking file
  // existence avoids decrypting safeStorage and triggering macOS keychain prompts.
  return existsSync(getOpenAiKeyPath())
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getOpenAiKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedOpenAiSpeechApiKey = trimmed
    return
  }

  console.warn(
    '[speech] safeStorage encryption unavailable — storing OpenAI speech key in plaintext'
  )
  writeFileSync(getOpenAiKeyPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedOpenAiSpeechApiKey = trimmed
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('OpenAI API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    const legacyJson = readLegacyJsonStoredOpenAiKey()
    if (legacyJson) {
      cachedOpenAiSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedOpenAiSpeechApiKey
    }
    cachedOpenAiSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedOpenAiSpeechApiKey
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
}

export function clearOpenAiSpeechApiKey(): void {
  cachedOpenAiSpeechApiKey = null
  rmSync(getOpenAiKeyPath(), { force: true })
}
