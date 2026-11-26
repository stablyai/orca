import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const store = createEncryptedApiKeyFileStore({
  fileName: 'command-code-api-key.enc',
  envelopePrefix: 'orca-command-code-api-key:v1:',
  providerLabel: 'Command Code',
  logScope: 'command-code'
})

export const hasCommandCodeApiKey = store.has
export const saveCommandCodeApiKey = store.save
export const readCommandCodeApiKey = store.read
export const clearCommandCodeApiKey = store.clear
export const commandCodeApiKeyEnvelopeFile = store.envelopeFile
export const commandCodeApiKeyProtection = store.protection
