import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEEPGRAM_SPEECH_TOKEN_FILE = 'deepgram-speech-token.enc'
const ENCRYPTED_STORAGE_UNAVAILABLE_MESSAGE =
  'Encrypted credential storage is unavailable. Deepgram API keys cannot be used on this system.'
let cachedDeepgramSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getDeepgramKeyPath(): string {
  return join(getOrcaDir(), DEEPGRAM_SPEECH_TOKEN_FILE)
}

export function hasDeepgramSpeechApiKey(): boolean {
  return safeStorage.isEncryptionAvailable() && existsSync(getDeepgramKeyPath())
}

export function saveDeepgramSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Deepgram API key is required')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(ENCRYPTED_STORAGE_UNAVAILABLE_MESSAGE)
  }
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getDeepgramKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
  cachedDeepgramSpeechApiKey = trimmed
}

export function readDeepgramSpeechApiKey(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(ENCRYPTED_STORAGE_UNAVAILABLE_MESSAGE)
  }
  if (cachedDeepgramSpeechApiKey !== null) {
    return cachedDeepgramSpeechApiKey
  }
  const keyPath = getDeepgramKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('Deepgram API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    cachedDeepgramSpeechApiKey = safeStorage.decryptString(raw)
    return cachedDeepgramSpeechApiKey
  } catch {
    throw new Error('Deepgram API key could not be decrypted')
  }
}

export function clearDeepgramSpeechApiKey(): void {
  cachedDeepgramSpeechApiKey = null
  rmSync(getDeepgramKeyPath(), { force: true })
}
