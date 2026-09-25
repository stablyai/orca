import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const store = createEncryptedApiKeyFileStore({
  fileName: 'minimax-api-key.enc',
  envelopePrefix: 'orca-minimax-api-key:v1:',
  providerLabel: 'MiniMax',
  logScope: 'minimax'
})

export const hasMiniMaxApiKey = store.has
export const saveMiniMaxApiKey = store.save
export const readMiniMaxApiKey = store.read
export const clearMiniMaxApiKey = store.clear
