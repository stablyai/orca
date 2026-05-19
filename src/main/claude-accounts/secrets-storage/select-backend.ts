import { createEncryptedFileBackend } from './encrypted-file-backend'
import { createKeychainBackend, probeKeychainAvailable } from './keychain-backend'
import { getProcessPassphraseHolder, promptForPassphrase } from './passphrase-prompt'
import { getEncryptedSecretsFilePath } from '../runtime-paths'
import type { SecretsStorage } from './types'

// Why: cache the selected backend per process — keychain probing fires an
// external CLI and the result cannot change without a restart anyway.
let cached: SecretsStorage | null = null

export function _resetSelectionCacheForTest(): void {
  cached = null
}

export async function selectSecretsBackend(opts: { userDataDir: string }): Promise<SecretsStorage> {
  if (cached) {
    return cached
  }
  if (process.env.ORCA_FORCE_ENCRYPTED_SECRETS === '1' || process.platform !== 'darwin') {
    cached = buildEncryptedFile(opts.userDataDir)
    return cached
  }
  const ok = await probeKeychainAvailable()
  cached = ok ? createKeychainBackend() : buildEncryptedFile(opts.userDataDir)
  return cached
}

function buildEncryptedFile(userDataDir: string): SecretsStorage {
  const holder = getProcessPassphraseHolder()
  return createEncryptedFileBackend({
    filePath: getEncryptedSecretsFilePath(userDataDir),
    holder,
    promptForPassphrase: (o) => promptForPassphrase({ mode: o.mode, holder })
  })
}
