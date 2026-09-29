import { createSpeechApiKeyStore } from './speech-api-key-store'

const store = createSpeechApiKeyStore('OpenRouter', 'openrouter-speech-token.enc')

export const hasOpenRouterSpeechApiKey = store.has
export const saveOpenRouterSpeechApiKey = store.save
export const readOpenRouterSpeechApiKey = store.read
export const clearOpenRouterSpeechApiKey = store.clear
