import { existsSync, readFileSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { inCredentialFileOrder } from '../credentials/credential-file-io'
import { dirname } from 'node:path'
import { writeCredentialFileAtomic } from '../credentials/integration-credential-file'
import { readPrivateWindowsCredentialFile } from '../../shared/secure-storage/windows-credential-file-io'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import type { AntigravityCredentialBackend } from './native-account-service'

const CONFLICT =
  'The native Antigravity credential changed during selection; refresh before retrying.'

const sessionBusAddressMissing = (env: NodeJS.ProcessEnv): boolean =>
  ['', 'none:', 'disabled:'].includes(env.DBUS_SESSION_BUS_ADDRESS ?? '')
const sessionBusSocket = (): string => `/run/user/${process.getuid?.()}/bus`

// Mirrors agy's Linux dbus detector: no session bus address and no per-user bus socket.
function lacksAntigravitySessionBus(env: NodeJS.ProcessEnv): boolean {
  if (!sessionBusAddressMissing(env)) {
    return false
  }
  try {
    return !statSync(sessionBusSocket()).isSocket()
  } catch {
    return true
  }
}

/** `isAntigravityFileStorageHost` and `isAntigravityContainerOrWslHost` together, read without
 *  blocking: where agy keeps its login in its token file on Linux. */
export async function antigravityUsesFileStoreAsync(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (forcesAntigravityFileStore(env)) {
    return true
  }
  if (process.platform !== 'linux') {
    return false
  }
  if (
    sessionBusAddressMissing(env) &&
    (await stat(sessionBusSocket()).then(
      (bus) => !bus.isSocket(),
      () => true
    ))
  ) {
    return true
  }
  if (
    await stat(DOCKER_MARKER).then(
      () => true,
      () => false
    )
  ) {
    return true
  }
  const texts = await Promise.all(
    CONTAINER_OR_WSL_MARKERS.map(([path]) => readFile(path, 'utf8').catch(() => ''))
  )
  return CONTAINER_OR_WSL_MARKERS.some(([, pattern], index) => pattern.test(texts[index] ?? ''))
}

/** agy keeps its login in a file, not a keyring, in a remote or WSL session. */
export function forcesAntigravityFileStore(env: NodeJS.ProcessEnv): boolean {
  return ['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'].some(
    (name) => Boolean(env[name])
  )
}

export function isAntigravityFileStorageHost(env: NodeJS.ProcessEnv): boolean {
  return (
    forcesAntigravityFileStore(env) ||
    (process.platform === 'linux' && lacksAntigravitySessionBus(env))
  )
}

const DOCKER_MARKER = '/.dockerenv'
const CONTAINER_OR_WSL_MARKERS = [
  ['/proc/1/cgroup', /docker|containerd|kubepods/],
  ['/proc/sys/kernel/osrelease', /microsoft|wsl/i]
] as const

export function isAntigravityContainerOrWslHost(): boolean {
  if (existsSync(DOCKER_MARKER)) {
    return true
  }
  for (const [path, pattern] of CONTAINER_OR_WSL_MARKERS) {
    try {
      if (pattern.test(readFileSync(path, 'utf8'))) {
        return true
      }
    } catch {}
  }
  return false
}

export async function readAntigravityCredentialFile(path: string): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const raw = await readPrivateWindowsCredentialFile(path, 64 * 1024)
      return raw ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) : null
    }
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    const stat = metadata
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) {
      throw new Error('unsafe credential file')
    }
    return await readFile(path, 'utf8')
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
      const contents = await readAntigravityCredentialFile(path)
      return contents === null ? null : parseCredential(contents)
    } catch {
      throw new Error('The Antigravity execution-host credential file could not be read safely.')
    }
  }
  return {
    read: () => inCredentialFileOrder(`${path}.mutation`, read),
    async write(contents, expected) {
      return inCredentialFileOrder(`${path}.mutation`, async () => {
        parseCredential(contents)
        if ((await read())?.contents !== (expected ?? undefined)) {
          throw new Error(CONFLICT)
        }
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await writeCredentialFileAtomic(path, Buffer.from(contents, 'utf8'), undefined, true)
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
      })
    }
  }
}
