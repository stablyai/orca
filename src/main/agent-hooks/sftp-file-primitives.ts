// Promise-shaped, timeout-guarded wrappers over ssh2's callback SFTP API,
// shared by the remote hook installers (`installer-utils-remote.ts`). Every
// operation has a bounded timeout so a wedged callback degrades hook status
// instead of blocking SSH workspace startup forever.

import type { SFTPWrapper } from 'ssh2'

const REMOTE_SFTP_OPERATION_TIMEOUT_MS = 10_000

export function sftpOperation<T>(
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
      // Why: remote hook installation must fail open; a wedged SFTP callback
      // should degrade hook status, not block SSH workspace startup forever.
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

export async function statMode(sftp: SFTPWrapper, remotePath: string): Promise<number> {
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

  // Why: servers without OpenSSH overwrite-rename cannot safely replace an
  // existing live config path. Renaming dst aside would leave settings.json
  // missing if the SFTP channel dies before src is moved into place, so fail
  // closed and keep the existing file intact.
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

async function mkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await sftpOperation<void>(`mkdir ${remotePath}`, (callback) => {
    sftp.mkdir(remotePath, callback)
  })
}

export async function mkdirpRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  if (remotePath === '/' || remotePath === '' || remotePath === '.') {
    return
  }
  // Why: stat avoids serializing a large directory listing for each ancestor.
  // POSIX-only — Windows-remote is out of scope for v1.
  const segments = remotePath.split('/').filter((s) => s.length > 0)
  let current = remotePath.startsWith('/') ? '' : '.'
  for (const seg of segments) {
    current = current === '' ? `/${seg}` : current === '.' ? seg : `${current}/${seg}`
    try {
      await statMode(sftp, current)
    } catch {
      try {
        await mkdir(sftp, current)
      } catch (err) {
        // Why: SSH_FX_FAILURE on a concurrent mkdir is harmless; a later probe or write proves usability.
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
  // SSH_FX_FAILURE (4) is OpenSSH's catch-all for "exists" alongside other
  // mkdir failures; the next ancestor probe or write proves usability.
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
