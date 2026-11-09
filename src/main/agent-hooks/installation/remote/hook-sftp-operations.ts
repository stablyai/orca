import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'

export const DEFAULT_REMOTE_CONFIG_MODE = 0o600

const REMOTE_SFTP_OPERATION_TIMEOUT_MS = 10_000

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

export async function readFile(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  const data = await sftpOperation<string | Buffer>(`readFile ${remotePath}`, (callback) => {
    sftp.readFile(remotePath, 'utf8', callback)
  })
  return typeof data === 'string' ? data : data.toString('utf8')
}

export async function writeFile(
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

export async function getRemoteFileModeOrDefault(
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

export async function rename(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
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

export async function unlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await sftpOperation<void>(`unlink ${remotePath}`, (callback) => {
    sftp.unlink(remotePath, callback)
  })
}

export async function chmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  await sftpOperation<void>(`chmod ${remotePath}`, (callback) => {
    sftp.chmod(remotePath, mode, callback)
  })
}

export async function readdir(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<FileEntryWithStats[]> {
  return await sftpOperation<FileEntryWithStats[]>(`readdir ${remotePath}`, (callback) => {
    sftp.readdir(remotePath, callback)
  })
}

async function mkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await sftpOperation<void>(`mkdir ${remotePath}`, (callback) => {
    sftp.mkdir(remotePath, callback)
  })
}

export async function mkdirpRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
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

export function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) {
    return idx === 0 ? '/' : '.'
  }
  return p.slice(0, idx)
}

export function isNoEntryError(err: unknown): boolean {
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
