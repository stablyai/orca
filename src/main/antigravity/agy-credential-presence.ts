// Whether agy may hold a login here, read without a prompt, so Orca never starts agy where its
// keyring lookup could raise an unlock dialog.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { antigravityKeyringFallbackMarker } from './native-credential-backend'
import { antigravityUsesFileStoreAsync } from './native-file-credentials'
import { hasAntigravityMacOSCredential } from './native-macos-credentials'
import {
  AntigravityKeyringToolMissingError,
  readAntigravityLinuxCredential
} from './native-linux-credentials'
import { hasAntigravityWindowsCredential } from './native-windows-credentials'

/** `locked`: the keyring can't be read without unlocking it, or Orca can't tell, so asking agy
 *  could prompt. */
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
  const tokenFile = (): Promise<AgyCredentialPresence> =>
    exists(join(homePath, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')).then((found) =>
      found ? 'present' : 'absent'
    )
  // Windows environment names are case-insensitive.
  const env =
    process.platform === 'win32'
      ? Object.fromEntries(
          Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])
        )
      : process.env
  // The same store choice agy's credential backends make.
  if (await antigravityUsesFileStoreAsync(env)) {
    return tokenFile()
  }
  // macOS reads the item's attributes, which would not ask for keychain access as its secret would;
  // Credential Manager reads never prompt. A failed read can't say the login is absent.
  const item =
    process.platform === 'darwin'
      ? hasAntigravityMacOSCredential
      : process.platform === 'win32'
        ? hasAntigravityWindowsCredential
        : null
  if (item) {
    const found = await item().then(
      (present) => (present ? 'present' : 'absent'),
      () => 'unread' as const
    )
    const file = found === 'present' ? 'present' : await tokenFile()
    return file === 'present' ? 'present' : found === 'unread' ? 'locked' : 'absent'
  }
  // The read refuses a locked collection rather than unlocking it. Without gdbus Orca can't tell
  // whether it is locked, so it stays `locked`; secret-tool is only needed after gdbus found the
  // collection unlocked, where asking agy can't prompt.
  const keyring = await readAntigravityLinuxCredential().then(
    (credential): AgyCredentialPresence | 'tokenFile' => (credential ? 'present' : 'tokenFile'),
    (error: unknown): AgyCredentialPresence =>
      error instanceof AntigravityKeyringToolMissingError && error.program === 'secret-tool'
        ? 'present'
        : 'locked'
  )
  return keyring === 'tokenFile' ? tokenFile() : keyring
}
