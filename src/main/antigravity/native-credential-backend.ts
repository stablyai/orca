import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readAntigravityMacOSCredential,
  readAntigravityMacOSCredentialRevision,
  writeAntigravityMacOSCredential,
  type AntigravityKeychainRevision
} from './native-macos-credentials'
import {
  readAntigravityLinuxCredential,
  writeAntigravityLinuxCredential
} from './native-linux-credentials'
import type { AntigravityCredentialBackend } from './native-account-service'
import type { AntigravityNativeCredential } from './native-credential-codec'
import {
  createAntigravityWindowsCredentialBackend,
  getAntigravityWindowsHome
} from './native-windows-credentials'
import {
  createAntigravityFileCredentialBackend,
  isAntigravityContainerOrWslHost,
  isAntigravityFileStorageHost
} from './native-file-credentials'
export {
  createAntigravityFileCredentialBackend,
  isAntigravityFileStorageHost
} from './native-file-credentials'

const markerPresent = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

const CONFLICT =
  'The native Antigravity credential changed during selection; refresh before retrying.'

function hostKeyring(): {
  read: () => Promise<AntigravityNativeCredential | null>
  write: (contents: string) => Promise<void>
  /** Only where reading the secret can raise a dialog: the Linux keyring refuses when locked. */
  revision?: () => Promise<AntigravityKeychainRevision | null>
} {
  if (process.platform === 'darwin') {
    return {
      read: () => readAntigravityMacOSCredential(),
      write: writeAntigravityMacOSCredential,
      revision: readAntigravityMacOSCredentialRevision
    }
  }
  if (process.platform === 'linux') {
    return { read: readAntigravityLinuxCredential, write: writeAntigravityLinuxCredential }
  }
  throw new Error('Native Antigravity account switching is not supported on this host.')
}

/** agy writes this after a keyring timeout and may read its file store for a while after. */
export function antigravityKeyringFallbackMarker(home: string): string {
  return join(home, '.gemini', 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable')
}

export function createAntigravityHostCredentialBackend(home: string): AntigravityCredentialBackend {
  if (process.platform === 'win32') {
    return createAntigravityWindowsCredentialBackend(getAntigravityWindowsHome(process.env))
  }
  const root = join(home, '.gemini', 'antigravity-cli')
  const file = createAntigravityFileCredentialBackend(join(root, 'antigravity-oauth-token'))
  if (
    isAntigravityFileStorageHost(process.env) ||
    (process.platform === 'linux' && isAntigravityContainerOrWslHost())
  ) {
    return file
  }
  const keyring = hostKeyring()
  const marker = antigravityKeyringFallbackMarker(home)
  async function refuseMarker() {
    if (await markerPresent(marker)) {
      throw new Error(
        'Antigravity has a keyring fallback marker; Orca cannot verify which credential store agy will use.'
      )
    }
  }
  async function read() {
    await refuseMarker()
    return (await keyring.read()) ?? (await file.read())
  }
  const { revision } = keyring
  return {
    read,
    ...(revision
      ? {
          async readWithoutPrompt() {
            await refuseMarker()
            const item = await revision()
            // With no keychain item agy uses its token file, which reads without a prompt.
            return item ?? { credential: await file.read() }
          }
        }
      : {}),
    async write(contents, expected) {
      if ((await read())?.contents !== (expected ?? undefined)) {
        throw new Error(CONFLICT)
      }
      const native = await keyring.read()
      if (await markerPresent(marker)) {
        throw new Error(CONFLICT)
      }
      if (native) {
        if (native.contents !== expected) {
          throw new Error(CONFLICT)
        }
        await keyring.write(contents)
      } else {
        await file.write(contents, expected)
      }
      if ((await read())?.contents !== contents) {
        throw new Error(CONFLICT)
      }
    }
  }
}
