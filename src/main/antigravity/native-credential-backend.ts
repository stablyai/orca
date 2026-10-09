import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import {
  readAntigravityMacOSCredential,
  writeAntigravityMacOSCredential
} from './native-macos-credentials'
import type { AntigravityCredentialBackend } from './native-account-service'

const CONFLICT =
  'The native Antigravity credential changed during selection; refresh before retrying.'

export function isAntigravityFileStorageHost(env: NodeJS.ProcessEnv, kernelRelease = ''): boolean {
  return (
    ['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'].some((name) =>
      Boolean(env[name])
    ) || /microsoft|wsl/i.test(kernelRelease)
  )
}

export function createAntigravityFileCredentialBackend(path: string): AntigravityCredentialBackend {
  async function read() {
    if (!existsSync(path)) {
      return null
    }
    try {
      const stat = lstatSync(path)
      if (
        !stat.isFile() ||
        stat.size > 64 * 1024 ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      ) {
        throw new Error('unsafe credential file')
      }
      return parseAntigravityNativeCredential(readFileSync(path, 'utf8'))
    } catch {
      throw new Error('The Antigravity execution-host credential file could not be read safely.')
    }
  }
  return {
    read,
    async write(contents, expected) {
      parseAntigravityNativeCredential(contents)
      if ((await read())?.contents !== (expected ?? undefined)) {
        throw new Error(CONFLICT)
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeCredentialFileAtomic(path, Buffer.from(contents, 'utf8'))
      if ((await read())?.contents !== contents) {
        throw new Error(CONFLICT)
      }
    }
  }
}

export function createAntigravityHostCredentialBackend(home: string): AntigravityCredentialBackend {
  if (process.platform === 'win32') {
    throw new Error(
      'Native Antigravity account switching is not supported on this host yet. Windows credential storage and private file permissions need a verified adapter.'
    )
  }
  const root = join(home, '.gemini', 'antigravity-cli')
  const file = createAntigravityFileCredentialBackend(join(root, 'antigravity-oauth-token'))
  let kernelRelease = ''
  if (process.platform === 'linux') {
    try {
      kernelRelease = readFileSync('/proc/sys/kernel/osrelease', 'utf8')
    } catch {
      /* Environment detectors remain authoritative. */
    }
  }
  if (isAntigravityFileStorageHost(process.env, kernelRelease)) {
    return file
  }
  if (process.platform !== 'darwin') {
    throw new Error(
      'Native Antigravity account switching is not supported on this host yet. Windows Credential Manager and Linux Secret Service need a verified adapter.'
    )
  }
  const marker = join(root, 'cache', 'antigravity-keyring-unavailable')
  async function read() {
    if (existsSync(marker)) {
      throw new Error(
        'Antigravity has a keyring fallback marker; Orca cannot verify which credential store agy will use.'
      )
    }
    return (await readAntigravityMacOSCredential()) ?? (await file.read())
  }
  return {
    read,
    async write(contents, expected) {
      if ((await read())?.contents !== (expected ?? undefined)) {
        throw new Error(CONFLICT)
      }
      const native = await readAntigravityMacOSCredential()
      if (existsSync(marker)) {
        throw new Error(CONFLICT)
      }
      if (native) {
        if (native.contents !== expected) {
          throw new Error(CONFLICT)
        }
        await writeAntigravityMacOSCredential(contents)
      } else {
        await file.write(contents, expected)
      }
      if ((await read())?.contents !== contents) {
        throw new Error(CONFLICT)
      }
    }
  }
}
