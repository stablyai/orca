import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  readAntigravityMacOSCredential,
  writeAntigravityMacOSCredential
} from './native-macos-credentials'
import {
  readAntigravityLinuxCredential,
  writeAntigravityLinuxCredential
} from './native-linux-credentials'
import type { AntigravityCredentialBackend } from './native-account-service'
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

const CONFLICT =
  'The native Antigravity credential changed during selection; refresh before retrying.'

function hostKeyring() {
  if (process.platform === 'darwin') {
    return { read: readAntigravityMacOSCredential, write: writeAntigravityMacOSCredential }
  }
  if (process.platform === 'linux') {
    return { read: readAntigravityLinuxCredential, write: writeAntigravityLinuxCredential }
  }
  throw new Error('Native Antigravity account switching is not supported on this host.')
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
  const marker = join(root, 'cache', 'antigravity-keyring-unavailable')
  async function read() {
    if (existsSync(marker)) {
      throw new Error(
        'Antigravity has a keyring fallback marker; Orca cannot verify which credential store agy will use.'
      )
    }
    return (await keyring.read()) ?? (await file.read())
  }
  return {
    read,
    async write(contents, expected) {
      if ((await read())?.contents !== (expected ?? undefined)) {
        throw new Error(CONFLICT)
      }
      const native = await keyring.read()
      if (existsSync(marker)) {
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
