import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache
} from '../../shared/secure-storage/secure-path-hardening-cache'
import { fileStatSignature } from '../filesystem/file-stat-signature'
import { bestEffortFsyncDirectory } from '../../shared/secure-storage/secure-file-async-write'
import {
  createWindowsCredentialStage,
  hardenWindowsCredentialPath
} from '../../shared/secure-storage/windows-credential-file-io'

const operations = new Map<string, Promise<unknown>>()

function credentialFileKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Keep reads, replacements and deletes in invocation order, including failed operations. */
export function inCredentialFileOrder<T>(path: string, run: () => Promise<T>): Promise<T> {
  const key = credentialFileKey(path)
  const next = (operations.get(key) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => {})
  operations.set(key, settled)
  void settled.then(() => {
    if (operations.get(key) === settled) {
      operations.delete(key)
    }
  })
  return next
}

export async function credentialFileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const hardenedPaths = new SecurePathHardeningCache<string>(DEFAULT_HARDENING_CACHE_BOUNDS)
async function hardenPosixCredentialPath(path: string, mode: number): Promise<void> {
  const read = async () => {
    const metadata = await stat(path, { bigint: true })
    return { signature: `${fileStatSignature(metadata)}:${metadata.mode}`, mode: metadata.mode }
  }
  const current = await read()
  if (hardenedPaths.get(path) === current.signature) {
    return
  }
  // A no-op chmod still bumps ctime, which misses every other process's cache and makes them chmod back (#44839).
  if ((current.mode & 0o7777n) === BigInt(mode)) {
    hardenedPaths.set(path, current.signature)
    return
  }
  await chmod(path, mode)
  hardenedPaths.set(path, (await read()).signature)
}

export async function hardenCredentialFile(path: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await hardenWindowsCredentialPath(dirname(path), true)
      await hardenWindowsCredentialPath(path, false)
    } else {
      await hardenPosixCredentialPath(dirname(path), 0o700)
      await hardenPosixCredentialPath(path, 0o600)
    }
  } catch (error) {
    if (
      !['ENOENT', 'EPERM', 'EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      throw error
    }
  }
}

export async function stageCredentialFile(
  path: string,
  data: string | Buffer,
  options: {
    durable?: boolean
    syncFile?: boolean
    shouldPublish?: () => boolean | Promise<boolean>
    requirePrivateWindowsFile?: boolean
    createDirectory?: boolean
  } = {}
): Promise<boolean> {
  const dir = dirname(path)
  if (options.createDirectory) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await (process.platform === 'win32'
      ? hardenWindowsCredentialPath(dir, true)
      : hardenPosixCredentialPath(dir, 0o700))
  }
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let restricted = true
  try {
    if (process.platform === 'win32') {
      restricted = await createWindowsCredentialStage(
        temp,
        data,
        options.requirePrivateWindowsFile ?? false,
        options.durable || options.syncFile
      )
      if (options.requirePrivateWindowsFile && !restricted) {
        throw new Error('Private Windows credential-file protection could not be verified.')
      }
    } else {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(data)
        await handle.chmod(0o600)
        if (options.durable || options.syncFile) {
          await handle.sync()
        }
      } finally {
        await handle.close()
      }
    }
    const shouldPublish = options.shouldPublish?.()
    if (
      shouldPublish !== undefined &&
      !(typeof shouldPublish === 'boolean' ? shouldPublish : await shouldPublish)
    ) {
      return false
    }
    await rename(temp, path)
    if (options.durable) {
      await bestEffortFsyncDirectory(dir)
    }
    return restricted
  } finally {
    await rm(temp, { force: true })
  }
}

export function writeCredentialEnvelope(
  path: string,
  data: string,
  options: { shouldPublish?: () => boolean | Promise<boolean> } = {}
): Promise<boolean> {
  return stageCredentialFile(path, data, { ...options, createDirectory: true })
}
