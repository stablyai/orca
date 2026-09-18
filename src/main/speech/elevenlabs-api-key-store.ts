import {
  clearStoredSpeechSecret,
  hasStoredSpeechSecret,
  readStoredSpeechSecret,
  writeStoredSpeechSecret
} from './speech-secret-file'

const ELEVENLABS_SPEECH_TOKEN_FILE = 'elevenlabs-speech-token.enc'
let cachedElevenLabsSpeechApiKey: string | null = null

export function hasElevenLabsSpeechApiKey(): boolean {
  return hasStoredSpeechSecret(ELEVENLABS_SPEECH_TOKEN_FILE)
}

export function saveElevenLabsSpeechApiKey(apiKey: string): void {
  writeStoredSpeechSecret(ELEVENLABS_SPEECH_TOKEN_FILE, apiKey, 'ElevenLabs')
  cachedElevenLabsSpeechApiKey = apiKey.trim()
}

export function readElevenLabsSpeechApiKey(): string {
  if (cachedElevenLabsSpeechApiKey !== null) {
    return cachedElevenLabsSpeechApiKey
  }

  cachedElevenLabsSpeechApiKey = readStoredSpeechSecret(ELEVENLABS_SPEECH_TOKEN_FILE, 'ElevenLabs')
  return cachedElevenLabsSpeechApiKey
}

export function clearElevenLabsSpeechApiKey(): void {
  cachedElevenLabsSpeechApiKey = null
  clearStoredSpeechSecret(ELEVENLABS_SPEECH_TOKEN_FILE)
}
