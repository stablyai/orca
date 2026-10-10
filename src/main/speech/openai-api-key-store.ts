import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  clearCloudSpeechApiKey,
  getCloudSpeechApiKeyProtection,
  hasCloudSpeechApiKey,
  readCloudSpeechApiKey,
  saveCloudSpeechApiKey
} from './cloud-speech-key-store'

// OpenAI-named wrappers kept for the original desktop IPC channels.

export function hasOpenAiSpeechApiKey(): boolean {
  return hasCloudSpeechApiKey('openai')
}

export function getOpenAiSpeechApiKeyProtection(): SecretAtRestProtection | null {
  return getCloudSpeechApiKeyProtection('openai')
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  saveCloudSpeechApiKey('openai', apiKey)
}

export function readOpenAiSpeechApiKey(): string {
  return readCloudSpeechApiKey('openai')
}

export function clearOpenAiSpeechApiKey(): void {
  clearCloudSpeechApiKey('openai')
}
