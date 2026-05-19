import { app } from 'electron'
import { selectSecretsBackend } from './select-backend'
import type { SecretsStorage } from './types'

export type { SecretsStorage, SecretsBackendId } from './types'
export { promptForPassphrase, getProcessPassphraseHolder } from './passphrase-prompt'

// Why: a process-wide override so tests can inject a fake backend without
// going through selectSecretsBackend (which probes the keychain CLI and reads
// app.getPath('userData')).
let override: SecretsStorage | null = null

export function setSecretsBackendForTest(backend: SecretsStorage | null): void {
  override = backend
}

export async function getSecretsBackend(): Promise<SecretsStorage> {
  if (override) {
    return override
  }
  const userDataDir = app.getPath('userData')
  return selectSecretsBackend({ userDataDir })
}
