// Whether agy may hold a login here, read without a prompt, so Orca never starts agy where its
// keyring lookup could raise an unlock dialog.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { antigravityKeyringFallbackMarker } from './native-credential-backend'
import { forcesAntigravityFileStore } from './native-file-credentials'
import { hasAntigravityMacOSCredential } from './native-macos-credentials'
import { readAntigravityLinuxCredential } from './native-linux-credentials'

/** `locked`: the keyring can't be read without unlocking it, so asking agy could prompt. */
export type AgyCredentialPresence = 'present' | 'absent' | 'locked'

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

export async function agyCredentialPresence(homePath: string): Promise<AgyCredentialPresence> {
  // After a keyring timeout agy may use either store, so the ACP readiness probe decides.
  if (await exists(antigravityKeyringFallbackMarker(homePath))) {
    return 'present'
  }
  const tokenFile = exists(join(homePath, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
  if (forcesAntigravityFileStore(process.env)) {
    return (await tokenFile) ? 'present' : 'absent'
  }
  if (process.platform === 'darwin') {
    // Reading the secret would ask for keychain access; its attributes do not.
    const item = await hasAntigravityMacOSCredential().catch(() => false)
    return item || (await tokenFile) ? 'present' : 'absent'
  }
  if (process.platform === 'linux') {
    // The read refuses a locked collection rather than unlocking it.
    const keyring = await readAntigravityLinuxCredential().then(
      (credential) => (credential ? 'present' : 'absent'),
      () => 'locked' as const
    )
    return keyring === 'absent' && (await tokenFile) ? 'present' : keyring
  }
  // agy's Windows credential store never prompts.
  return 'present'
}
