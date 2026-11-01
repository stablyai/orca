// Share parsing and merge rules with local installation; replace only filesystem operations.

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { sftpOperation } from './sftp-operation'
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'

import type { HooksConfig } from './installer-utils'
import { parseHooksJsonText } from './hooks-json-read'

const DEFAULT_REMOTE_CONFIG_MODE = 0o600

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
  await publishRemoteFile(
    sftp,
    remotePath,
    options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  )
}

/** POSIX SSH targets only: paths and script payloads follow POSIX conventions. */
export async function writeManagedScriptRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  await publishRemoteFile(sftp, remotePath, content, 0o755)
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
  await publishRemoteFile(sftp, remotePath, content)
}

type PublishingSftp = SFTPWrapper & {
  publishAtomicFile?: (path: string, content: string, mode?: number) => Promise<boolean>
}

async function publishRemoteFile(
  sftp: PublishingSftp,
  logicalPath: string,
  content: string,
  requiredMode?: number
): Promise<void> {
  const publish = sftp.publishAtomicFile
  if (
    publish &&
    (await sftpOperation<boolean>(`publish ${logicalPath}`, (callback) => {
      publish(logicalPath, content, requiredMode).then(
        (handled) => callback(null, handled),
        (error) => callback(error)
      )
    }))
  ) {
    return
  }
  let target = logicalPath
  // Real SFTP resolves remotely; partial legacy facades keep their established path semantics.
  if (typeof sftp.lstat === 'function' && typeof sftp.realpath === 'function') {
    try {
      await sftpOperation(`lstat ${logicalPath}`, (callback) => sftp.lstat(logicalPath, callback))
      target = await sftpOperation<string>(`realpath ${logicalPath}`, (callback) =>
        sftp.realpath(logicalPath, callback)
      )
    } catch (error) {
      if (
        !isNoEntryError(error) &&
        !(error instanceof Error && 'code' in error && error.code === 'ELOOP')
      ) {
        throw error
      }
    }
  }
  let equal = false
  try {
    equal = (await readFile(sftp, target)) === content
  } catch {
    // Publication still has to pass the target's permissions after a failed read.
  }
  if (equal) {
    if (requiredMode !== undefined) {
      await chmod(sftp, target, requiredMode)
    }
    return
  }
  const dir = posix.dirname(target)
  await mkdirpRemote(sftp, dir)
  const mode =
    requiredMode ?? (await getRemoteFileModeOrDefault(sftp, target, DEFAULT_REMOTE_CONFIG_MODE))
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    await writeFile(sftp, tmp, content, mode)
    await chmod(sftp, tmp, mode)
    await rename(sftp, tmp, target)
  } finally {
    await unlink(sftp, tmp).catch(() => {})
  }
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
    mode === undefined
      ? { encoding: 'utf8' as const, flag: 'wx' }
      : { encoding: 'utf8' as const, flag: 'wx', mode }
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
    if (isNoEntryError(err) || (err instanceof Error && 'code' in err && err.code === 'ELOOP')) {
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

export async function renamePlain(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
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
  let current = posix.normalize(remotePath)
  const missing: string[] = []
  const prepare = async (path: string): Promise<boolean> => {
    try {
      await mkdir(sftp, path)
      return true
    } catch {
      let mode: number
      try {
        const stats = await sftpOperation<{ mode: number }>(`stat ${path}`, (callback) =>
          sftp.stat(path, callback)
        )
        mode = stats.mode
      } catch (error) {
        // Sparse servers may deny metadata while allowing writes; the actual child/temp write decides.
        return !isNoEntryError(error)
      }
      if ((mode & 0o170000) !== 0o040000) {
        throw Object.assign(new Error(`Not a remote directory: ${path}`), { code: 2 })
      }
      return true
    }
  }
  // Deepest first preserves old guests that admit HOME but refuse ancestor mkdir/stat.
  while (current !== '/' && current !== '.' && current !== '') {
    if (await prepare(current)) {
      break
    }
    missing.push(current)
    current = posix.dirname(current)
  }
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    // Sparse metadata can report missing for a writable path; the final write verifies it.
    await prepare(missing[index])
  }
}

function isNoEntryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  // ssh2 surfaces SFTP errors with `code === 2` (SSH_FX_NO_SUCH_FILE).
  return 'code' in err && err.code === 2
}

function isUnsupportedExtensionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = 'code' in err ? err.code : undefined
  const message = 'message' in err ? err.message : undefined
  return code === 8 || (typeof message === 'string' && /unsupported/i.test(message))
}
