import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import type { FileStat } from './types'

const ABORTED_SFTP_OPERATION_GRACE_MS = 5_000

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Download canceled')
}

function waitForSftpCallback<T>(
  register: (callback: (err?: Error | null, value?: T) => void) => void,
  options?: { signal?: AbortSignal }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }

    let settled = false
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(abortTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (error?: Error | null, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (signal?.aborted) {
        reject(abortReason(signal))
      } else if (error) {
        reject(error)
      } else {
        resolve(value as T)
      }
    }
    const onAbort = (): void => {
      if (!signal || settled) {
        return
      }
      // Why: the folder owner closes SFTP on abort; wait for its callback so
      // Windows local handles quiesce before the temporary tree is removed.
      abortTimer = setTimeout(() => settle(abortReason(signal)), ABORTED_SFTP_OPERATION_GRACE_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      register((error, value) => settle(error, value))
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function fileStatFromSftpStats(stats: Stats): FileStat {
  let type: FileStat['type'] = 'file'
  if (stats.isDirectory()) {
    type = 'directory'
  } else if (stats.isSymbolicLink()) {
    type = 'symlink'
  }
  const maybeNlink = (stats as Stats & { nlink?: unknown }).nlink
  return {
    size: stats.size,
    type,
    mtime: stats.mtime * 1000,
    ...(typeof maybeNlink === 'number' ? { nlink: maybeNlink } : {})
  }
}

export function lstatViaSftp(sftp: SFTPWrapper, filePath: string): Promise<FileStat> {
  return new Promise((resolve, reject) => {
    sftp.lstat(filePath, (err, stats) => {
      if (err) {
        reject(err)
        return
      }
      resolve(fileStatFromSftpStats(stats))
    })
  })
}

export function fastGetViaSftp(
  sftp: SFTPWrapper,
  sourcePath: string,
  destinationPath: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  return waitForSftpCallback<void>(
    (callback) => sftp.fastGet(sourcePath, destinationPath, callback),
    options
  )
}

export async function* readDirectoryEntriesViaSftp(
  sftp: SFTPWrapper,
  dirPath: string,
  options?: { signal?: AbortSignal }
): AsyncGenerator<FileEntryWithStats> {
  const handle = await waitForSftpCallback<Buffer>(
    (callback) => sftp.opendir(dirPath, callback),
    options
  )
  try {
    for (;;) {
      const entries = await waitForSftpCallback<FileEntryWithStats[] | false>(
        (callback) =>
          sftp.readdir(handle, (error, value) => {
            if ((error as { code?: number } | undefined)?.code === 1) {
              callback(null, false)
              return
            }
            callback(error, value && value.length > 0 ? value : false)
          }),
        options
      )
      if (entries === false) {
        break
      }
      yield* entries
    }
  } finally {
    await waitForSftpCallback<void>((callback) => sftp.close(handle, callback), options).catch(
      () => undefined
    )
  }
}

export function statViaSftp(
  sftp: SFTPWrapper,
  filePath: string,
  options?: { signal?: AbortSignal }
): Promise<Stats> {
  return waitForSftpCallback<Stats>((callback) => sftp.stat(filePath, callback), options)
}
