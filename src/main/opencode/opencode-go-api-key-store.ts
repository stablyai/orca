import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const store = createEncryptedApiKeyFileStore({
  fileName: 'opencode-go-api-key.enc',
  envelopePrefix: 'orca-opencode-go-api-key:v1:',
  providerLabel: 'OpenCode Go',
  logScope: 'opencode-go'
})

export const hasOpenCodeGoApiKey = store.has
export const saveOpenCodeGoApiKey = store.save
export const readOpenCodeGoApiKey = store.read
export const clearOpenCodeGoApiKey = store.clear
