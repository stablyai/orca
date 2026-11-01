import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import { readPrivateWindowsFile } from '../../shared/secure-path-windows-acl'
import { parseAntigravityNativeCredential } from './native-credential-codec'
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

export function readAntigravityCredentialFile(path: string): string | null {
  try {
    if (process.platform === 'win32') {
      const raw = readPrivateWindowsFile(path, 64 * 1024)
      return raw ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) : null
    }
    if (!existsSync(path)) {
      return null
    }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) {
      throw new Error('unsafe credential file')
    }
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error('The Antigravity execution-host credential file could not be read safely.')
  }
}

export function createAntigravityFileCredentialBackend(
  path: string,
  parseCredential = parseAntigravityNativeCredential
): AntigravityCredentialBackend {
  async function read() {
    try {
      const contents = readAntigravityCredentialFile(path)
      return contents === null ? null : parseCredential(contents)
    } catch {
      throw new Error('The Antigravity execution-host credential file could not be read safely.')
    }
  }
  return {
    read,
    async write(contents, expected) {
      parseCredential(contents)
      if ((await read())?.contents !== (expected ?? undefined)) {
        throw new Error(CONFLICT)
      }
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeCredentialFileAtomic(path, Buffer.from(contents, 'utf8'), undefined, true)
      } catch (error) {
        if (process.platform === 'win32') {
          throw new Error(
            'Antigravity could not update its credential file privately. Check the file permissions and try again.'
          )
        }
        throw error
      }
      if ((await read())?.contents !== contents) {
        throw new Error(CONFLICT)
      }
    }
  }
}
