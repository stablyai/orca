import { existsSync, readFileSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'
import {
  clearStoredSpeechSecret,
  getSpeechSecretFilePath,
  hasStoredSpeechSecret,
  readStoredSpeechSecret,
  writeStoredSpeechSecret
} from './speech-secret-file'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null

function readLegacyJsonStoredOpenAiKey(): StoredOpenAiKey | null {
  const keyPath = getSpeechSecretFilePath(OPENAI_SPEECH_TOKEN_FILE)
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
  return hasStoredSpeechSecret(OPENAI_SPEECH_TOKEN_FILE)
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  writeStoredSpeechSecret(OPENAI_SPEECH_TOKEN_FILE, apiKey, 'OpenAI')
  cachedOpenAiSpeechApiKey = apiKey.trim()
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  // Why: installs from before the sealed-blob format keep the key inside a JSON envelope.
  // Reading that shape (instead of migrating it) preserves the existing decrypt contract.
  const legacyJson = readLegacyJsonStoredOpenAiKey()
  if (legacyJson) {
    try {
      cachedOpenAiSpeechApiKey = getSecretStore().decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedOpenAiSpeechApiKey
    } catch {
      throw new Error('OpenAI API key could not be decrypted')
    }
  }

  cachedOpenAiSpeechApiKey = readStoredSpeechSecret(OPENAI_SPEECH_TOKEN_FILE, 'OpenAI')
  return cachedOpenAiSpeechApiKey
}

export function clearOpenAiSpeechApiKey(): void {
  cachedOpenAiSpeechApiKey = null
  clearStoredSpeechSecret(OPENAI_SPEECH_TOKEN_FILE)
}
