import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../shared/file-access/cross-platform-path'
import { sanitizeLocalDownloadFilename } from '../ipc/filesystem/downloads/local-download-filename'
import { fastGetViaSftp } from './file-transfer/sftp/sftp-download'

type SftpFactory = (signal?: AbortSignal) => Promise<SFTPWrapper>

export async function downloadFolderViaSftp(
  createSftp: SftpFactory,
  sourcePath: string,
  destinationPath: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const signal = options?.signal
  signal?.throwIfAborted()
  const sftp = await createSftp(signal)
  const endSftp = (): void => {
    try {
      sftp.end()
    } catch {
      // Cleanup must not replace the transfer error.
    }
  }
  signal?.addEventListener('abort', endSftp, { once: true })
  try {
    const rootStats = await statViaSftp(sftp, sourcePath, signal)
    if (!rootStats.isDirectory()) {
      throw new Error('Cannot download a file as a folder')
    }
    await downloadDirectoryTree(sftp, sourcePath, destinationPath, signal)
  } finally {
    signal?.removeEventListener('abort', endSftp)
    endSftp()
  }
}

async function downloadDirectoryTree(
  sftp: SFTPWrapper,
  sourceDir: string,
  destinationDir: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const entries = await readDirectoryEntriesViaSftp(sftp, sourceDir, signal)
  const usedLocalNames = new Set<string>()
  const plannedEntries: {
    entry: FileEntryWithStats
    kind: 'directory' | 'file'
    localName: string
  }[] = []

  for (const entry of entries) {
    const localName = sanitizeLocalDownloadFilename(entry.filename)
    if (usedLocalNames.has(localName)) {
      throw new Error(`Remote entries map to the same local name '${localName}'`)
    }
    usedLocalNames.add(localName)
    if (entry.attrs.isSymbolicLink()) {
      throw new Error(`Cannot download symbolic link '${entry.filename}'`)
    }
    if (entry.attrs.isDirectory()) {
      plannedEntries.push({ entry, kind: 'directory', localName })
    } else if (entry.attrs.isFile()) {
      plannedEntries.push({ entry, kind: 'file', localName })
    } else {
      throw new Error(`Cannot download unsupported remote entry '${entry.filename}'`)
    }
  }

  await mkdir(destinationDir)
  for (const { entry, kind, localName } of plannedEntries) {
    signal?.throwIfAborted()
    const remotePath = joinSftpChildPath(sourceDir, entry.filename)
    const localPath = join(destinationDir, localName)
    if (kind === 'directory') {
      await downloadDirectoryTree(sftp, remotePath, localPath, signal)
      continue
    }
    await reserveLocalFile(localPath, localName)
    await fastGetViaSftp(sftp, remotePath, localPath, { signal })
  }
}

async function reserveLocalFile(localPath: string, localName: string): Promise<void> {
  try {
    const handle = await open(localPath, 'wx')
    await handle.close()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Remote entries map to the same local name '${localName}'`)
    }
    throw error
  }
}

function joinSftpChildPath(sourceDir: string, childName: string): string {
  const windowsPath = isWindowsAbsolutePathLike(sourceDir)
  if (
    !childName ||
    childName === '.' ||
    childName === '..' ||
    childName.includes('/') ||
    (windowsPath && childName.includes('\\'))
  ) {
    throw new Error(`Invalid remote directory entry '${childName}'`)
  }
  const normalizedSource = windowsPath ? normalizeRuntimePathSeparators(sourceDir) : sourceDir
  return `${normalizedSource.replace(/\/+$/g, '')}/${childName}`
}

function statViaSftp(sftp: SFTPWrapper, path: string, signal?: AbortSignal): Promise<Stats> {
  return waitForSftpCallback((callback) => sftp.stat(path, callback), signal)
}

function readDirectoryEntriesViaSftp(
  sftp: SFTPWrapper,
  path: string,
  signal?: AbortSignal
): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    sftp.opendir(path, (openError, handle) => {
      if (openError || !handle) {
        reject(openError ?? new Error('Remote directory could not be opened'))
        return
      }
      const entries: FileEntryWithStats[] = []
      const readNext = (): void => {
        if (signal?.aborted) {
          void closeSftpDirectory(sftp, handle)
          reject(signal.reason instanceof Error ? signal.reason : new Error('Download canceled'))
          return
        }
        sftp.readdir(handle, (error, chunk) => {
          if (error) {
            if (isSftpEndOfDirectory(error)) {
              void closeSftpDirectory(sftp, handle).then(() => resolve(entries), reject)
            } else {
              void closeSftpDirectory(sftp, handle).finally(() => reject(error))
            }
            return
          }
          if (!chunk) {
            void closeSftpDirectory(sftp, handle).then(() => resolve(entries), reject)
            return
          }
          entries.push(
            ...chunk.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          )
          readNext()
        })
      }
      readNext()
    })
  })
}

function isSftpEndOfDirectory(error: Error): boolean {
  return 'code' in error && error.code === 1
}

function closeSftpDirectory(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()))
  })
}

function waitForSftpCallback<T>(
  register: (callback: (error: Error | undefined, value?: T) => void) => void,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Download canceled'))
      return
    }
    const onAbort = (): void => {
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Download canceled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    register((error, value) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        onAbort()
      } else if (error) {
        reject(error)
      } else if (value === undefined) {
        reject(new Error('SFTP operation returned no result'))
      } else {
        resolve(value)
      }
    })
  })
}
