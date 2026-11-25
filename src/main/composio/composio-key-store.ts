// The owner's Composio project key, encrypted in ~/.orca on the host that runs the bots.
import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'

const store = createEncryptedApiKeyFileStore({
  fileName: 'composio-api-key.enc',
  envelopePrefix: 'orca-composio-api-key:v1:',
  providerLabel: 'Composio',
  logScope: 'composio'
})

export const hasComposioKey = store.has
export const saveComposioKey = store.save
export const clearComposioKey = store.clear
/** For orcad's migration, which seals a key a headless server saved in plaintext. */
export const composioKeyEnvelopeFile = store.envelopeFile

/** The key, or null when none is saved; throws when it's saved but can't be decrypted. */
export const readComposioKey = store.read
