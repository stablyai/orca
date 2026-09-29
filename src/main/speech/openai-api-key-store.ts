import { createSpeechApiKeyStore } from './speech-api-key-store'

const store = createSpeechApiKeyStore('OpenAI', 'openai-speech-token.enc')

export const hasOpenAiSpeechApiKey = store.has
export const saveOpenAiSpeechApiKey = store.save
export const readOpenAiSpeechApiKey = store.read
export const clearOpenAiSpeechApiKey = store.clear
