// Share parsing and merge rules with local installation; replace only filesystem operations.

import { randomUUID } from 'node:crypto'
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'

import type { HooksConfig } from './installer-utils'
import { parseHooksJsonText } from './hooks-json-read'

const DEFAULT_REMOTE_CONFIG_MODE = 0o600
const REMOTE_SFTP_OPERATION_TIMEOUT_MS = 10_000

/** Null means invalid JSON, {} means missing; propagate other I/O failures. */
export async function readHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksConfig | null> {
  let body: string
  try {
    body = await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return {}
    }
    throw err
  }
  return parseHooksJsonText(body)
}

/** Atomically replace the remote config without rotating local-style backups. */
export async function writeHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  config: Record<string, unknown>,
  // JSONC callers can supply text edited in place.
  options?: { serialized?: string }
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  // Preserve mtime and inode on repeated installs.
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === serialized) {
      return
    }
  } catch {
    // Retry through the write path after a failed read.
  }
  // Atomic replacement prevents interrupted writes from truncating live settings.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, serialized, mode)
    await chmod(sftp, tmp, mode)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}

/** POSIX SSH targets only: paths and script payloads follow POSIX conventions. */
export async function writeManagedScriptRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === content) {
      await chmod(sftp, remotePath, 0o755)
      return
    }
  } catch {
    // Retry through the atomic write path after a failed read.
  }

  // Publish only a complete executable script; existing configs may invoke it during reinstall.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    await writeFile(sftp, tmp, content, 0o755)
    await chmod(sftp, tmp, 0o755)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}

export async function readTextFileRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<string | null> {
  try {
    return await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return null
    }
    throw err
  }
}

/** Null means the directory is missing; propagate other I/O failures. */
export async function listRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<string[] | null> {
  try {
    return (await readdir(sftp, remotePath)).map((entry) => entry.filename)
  } catch (err) {
    if (isNoEntryError(err)) {
      return null
    }
    throw err
  }
}

export async function writeTextFileRemoteAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === content) {
      return
    }
  } catch {
    // Retry through the atomic write path after a failed read.
  }

  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, content, mode)
    await chmod(sftp, tmp, mode)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}

function sftpOperation<T>(
  label: string,
  run: (callback: (err: unknown, value?: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      // A wedged SFTP callback must not block workspace startup indefinitely.
      reject(new Error(`Timed out waiting for SFTP ${label}`))
    }, REMOTE_SFTP_OPERATION_TIMEOUT_MS)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    const finish = (err: unknown, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (err) {
        reject(err)
        return
      }
      resolve(value as T)
    }

    try {
      run(finish)
    } catch (error) {
      finish(error)
    }
  })
}

async function readFile(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  const data = await sftpOperation<string | Buffer>(`readFile ${remotePath}`, (callback) => {
    sftp.readFile(remotePath, 'utf8', callback)
  })
  return typeof data === 'string' ? data : data.toString('utf8')
}

async function writeFile(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string,
  mode?: number
): Promise<void> {
  const options =
    mode === undefined ? { encoding: 'utf8' as const } : { encoding: 'utf8' as const, mode }
  await sftpOperation<void>(`writeFile ${remotePath}`, (callback) => {
    sftp.writeFile(remotePath, content, options, callback)
  })
}

async function statMode(sftp: SFTPWrapper, remotePath: string): Promise<number> {
  const stats = await sftpOperation<{ mode: number }>(`stat ${remotePath}`, (callback) => {
    sftp.stat(remotePath, callback)
  })
  return stats.mode & 0o7777
}

async function getRemoteFileModeOrDefault(
  sftp: SFTPWrapper,
  remotePath: string,
  defaultMode: number
): Promise<number> {
  try {
    return await statMode(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return defaultMode
    }
    throw err
  }
}

async function rename(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await renameOpenSsh(sftp, src, dst)
      return
    } catch (err) {
      if (!isUnsupportedExtensionError(err)) {
        throw err
      }
    }
  }

  // Never rename the live destination aside: a dropped connection could leave the config missing.
  await renamePlain(sftp, src, dst)
}

async function renamePlain(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  await sftpOperation<void>(`rename ${src}`, (callback) => {
    sftp.rename(src, dst, callback)
  })
}

async function renameOpenSsh(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  await sftpOperation<void>(`openssh_rename ${src}`, (callback) => {
    sftp.ext_openssh_rename(src, dst, callback)
  })
}

async function unlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await sftpOperation<void>(`unlink ${remotePath}`, (callback) => {
    sftp.unlink(remotePath, callback)
  })
}

async function chmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  await sftpOperation<void>(`chmod ${remotePath}`, (callback) => {
    sftp.chmod(remotePath, mode, callback)
  })
}

async function readdir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
  return await sftpOperation<FileEntryWithStats[]>(`readdir ${remotePath}`, (callback) => {
    sftp.readdir(remotePath, callback)
  })
}

async function mkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await sftpOperation<void>(`mkdir ${remotePath}`, (callback) => {
    sftp.mkdir(remotePath, callback)
  })
}

async function mkdirpRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  if (remotePath === '/' || remotePath === '' || remotePath === '.') {
    return
  }
  // Walk POSIX paths top-down to avoid rescanning the full parent chain for each segment.
  const segments = remotePath.split('/').filter((s) => s.length > 0)
  let current = remotePath.startsWith('/') ? '' : '.'
  for (const seg of segments) {
    current = current === '' ? `/${seg}` : current === '.' ? seg : `${current}/${seg}`
    try {
      await readdir(sftp, current)
    } catch {
      try {
        await mkdir(sftp, current)
      } catch (err) {
        // Concurrent mkdir may report SSH_FX_FAILURE; subsequent operations still verify the path.
        if (!isAlreadyExistsError(err)) {
          throw err
        }
      }
    }
  }
}

function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) {
    return idx === 0 ? '/' : '.'
  }
  return p.slice(0, idx)
}

function isNoEntryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  // ssh2 surfaces SFTP errors with `code === 2` (SSH_FX_NO_SUCH_FILE).
  return (err as { code?: unknown }).code === 2
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  // SSH_FX_FAILURE (4) can mean "exists"; tolerate it here and let later operations expose other failures.
  return (err as { code?: unknown }).code === 4
}

function isUnsupportedExtensionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = (err as { code?: unknown }).code
  const message = (err as { message?: unknown }).message
  return code === 8 || (typeof message === 'string' && /unsupported/i.test(message))
}
