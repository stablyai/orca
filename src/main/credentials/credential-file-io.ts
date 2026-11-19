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

/** Keep reads, replacements and deletes in invocation order, including failed operations. */
export function inCredentialFileOrder<T>(path: string, run: () => Promise<T>): Promise<T> {
  const absolute = resolve(path)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
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
  const signature = async () => {
    const metadata = await stat(path, { bigint: true })
    return `${fileStatSignature(metadata)}:${metadata.mode}`
  }
  if (hardenedPaths.get(path) === (await signature())) {
    return
  }
  await chmod(path, mode)
  hardenedPaths.set(path, await signature())
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
      // Create the private inode before asynchronously writing any secret bytes.
      restricted = await createWindowsCredentialStage(
        temp,
        options.requirePrivateWindowsFile ?? false
      )
      if (options.requirePrivateWindowsFile && !restricted) {
        throw new Error('Private Windows credential-file protection could not be verified.')
      }
    }
    const handle = await open(temp, process.platform === 'win32' ? 'r+' : 'wx', 0o600)
    try {
      await handle.writeFile(data)
      if (process.platform !== 'win32') {
        await handle.chmod(0o600)
      }
      if (options.durable || options.syncFile) {
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
    if (options.shouldPublish && !(await options.shouldPublish())) {
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
