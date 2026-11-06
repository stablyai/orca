// Always report available to prevent plaintext fallback; throw on seal/unseal when the key is unavailable.
import type { SecretStore } from '../../shared/secret-store'
import { sweepStaleRecordStaging } from './orcad-secret-key-record'
import {
  orcadSecretStatePath,
  resolveState,
  type OrcadSecretStorePrepareOptions,
  type StoreState
} from './orcad-secret-key-resolution'
import { openOrcadSecret, sealOrcadSecret } from './orcad-secret-sealing'

export type OrcadSecretStore = SecretStore & {
  prepare(options: OrcadSecretStorePrepareOptions): Promise<boolean>
}

export function createOrcadSecretStore(
  log: (message: string) => void = (message) => console.warn(message)
): OrcadSecretStore {
  let state: StoreState = { kind: 'pending' }
  const readyKey = (): Buffer => {
    if (state.kind === 'ready') {
      return state.key
    }
    throw new Error(
      state.kind === 'unavailable'
        ? state.message
        : 'orcad_secret_store_not_prepared — the headless secret store has not loaded its key yet'
    )
  }
  return {
    isEncryptionAvailable: () => state.kind !== 'plaintext',
    encryptString: (plainText) => sealOrcadSecret(readyKey(), plainText),
    decryptString: (cipher) => openOrcadSecret(readyKey(), cipher),
    describeProtectionGap: () => {
      switch (state.kind) {
        case 'ready':
          return state.gap
        case 'unavailable':
          return state.message
        case 'plaintext':
          return state.reason
        case 'pending':
          return "Orca's headless server has not loaded its credential key yet."
      }
    },
    async prepare(next) {
      sweepStaleRecordStaging(orcadSecretStatePath(next))
      state = await resolveState(next, log)
      return state.kind === 'ready'
    }
  }
}
