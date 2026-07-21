import { fstatSync, lstatSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

const LOCAL_COPY_CHUNK_BYTES = 1024 * 1024

type PublishedEntry = {
  kind: 'directory' | 'file'
  path: string
  identity: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
  fileState?: Pick<BigIntStats, 'size' | 'mtimeNs' | 'mode'>
}

function isEEXIST(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function hasSameIdentity(current: BigIntStats, published: PublishedEntry): boolean {
  const { identity } = published
  const hasStableInode = identity.dev !== 0n || identity.ino !== 0n
  if (hasStableInode) {
    return current.dev === identity.dev && current.ino === identity.ino
  }
  return identity.birthtimeNs !== 0n && current.birthtimeNs === identity.birthtimeNs
}

function hasSamePublishedFileState(current: BigIntStats, published: PublishedEntry): boolean {
  const state = published.fileState
  return (
    state === undefined ||
    (current.size === state.size &&
      current.mtimeNs === state.mtimeNs &&
      current.mode === state.mode)
  )
}

function publishedEntryFromStats(
  kind: PublishedEntry['kind'],
  filePath: string,
  stats: BigIntStats
): PublishedEntry {
  return {
    kind,
    path: filePath,
    identity: { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs },
    ...(kind === 'file'
      ? {
          fileState: {
            size: stats.size,
            mtimeNs: stats.mtimeNs,
            mode: stats.mode
          }
        }
      : {})
  }
}

function updatePublishedFileState(entry: PublishedEntry, stats: BigIntStats): void {
  Object.assign(entry, publishedEntryFromStats('file', entry.path, stats))
}

async function closeFileHandle(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => {})
}

async function copyTrackedLocalDownloadedFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  publishedEntries: PublishedEntry[],
  signal?: AbortSignal
): Promise<void> {
  let sourceHandle: FileHandle | undefined
  let destinationHandle: FileHandle | undefined
  let record: PublishedEntry | undefined
  try {
    sourceHandle = await open(sourcePath, 'r')
    destinationHandle = await open(destinationPath, 'wx')
    record = publishedEntryFromStats(
      'file',
      destinationPath,
      fstatSync(destinationHandle.fd, { bigint: true })
    )
    publishedEntries.push(record)
    const buffer = Buffer.allocUnsafe(LOCAL_COPY_CHUNK_BYTES)
    let position = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }
      let written = 0
      while (written < bytesRead) {
        signal?.throwIfAborted()
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        )
        written += result.bytesWritten
      }
      position += bytesRead
    }
    updatePublishedFileState(record, await destinationHandle.stat({ bigint: true }))
  } catch (error) {
    if (record && destinationHandle) {
      await destinationHandle
        .stat({ bigint: true })
        .then((stats) => updatePublishedFileState(record!, stats))
        .catch(() => {})
    }
    throw error
  } finally {
    await Promise.all([closeFileHandle(sourceHandle), closeFileHandle(destinationHandle)])
  }
  await unlink(sourcePath)
}

async function publishTrackedFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  publishedEntries: PublishedEntry[],
  signal?: AbortSignal
): Promise<void> {
  const sourceStats = await lstat(sourcePath, { bigint: true })
  const hardLinkRecord = publishedEntryFromStats('file', destinationPath, sourceStats)
  try {
    await link(sourcePath, destinationPath)
  } catch (error) {
    if (isEEXIST(error)) {
      throw error
    }
    await copyTrackedLocalDownloadedFileNoClobber(
      sourcePath,
      destinationPath,
      publishedEntries,
      signal
    )
    return
  }
  // Why: hard links preserve dev+ino; register that known ownership first,
  // then synchronously snapshot state without an async third-party window.
  publishedEntries.push(hardLinkRecord)
  updatePublishedFileState(hardLinkRecord, lstatSync(destinationPath, { bigint: true }))
  signal?.throwIfAborted()
  await unlink(sourcePath)
}

export async function copyLocalDownloadedFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal
): Promise<void> {
  const publishedEntries: PublishedEntry[] = []
  try {
    await copyTrackedLocalDownloadedFileNoClobber(
      sourcePath,
      destinationPath,
      publishedEntries,
      signal
    )
  } catch (error) {
    await rollbackPublishedEntries(publishedEntries)
    throw error
  }
}

export async function publishLocalDownloadedFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal
): Promise<void> {
  const publishedEntries: PublishedEntry[] = []
  try {
    await publishTrackedFileNoClobber(sourcePath, destinationPath, publishedEntries, signal)
  } catch (error) {
    await rollbackPublishedEntries(publishedEntries)
    throw error
  }
}

async function rollbackPublishedEntries(entries: PublishedEntry[]): Promise<void> {
  for (const entry of entries.toReversed()) {
    try {
      const current = await lstat(entry.path, { bigint: true })
      if (!hasSameIdentity(current, entry)) {
        continue
      }
      if (entry.kind === 'file') {
        if (hasSamePublishedFileState(current, entry)) {
          await unlink(entry.path)
        }
      } else {
        // Why: rmdir removes only our still-empty directory; third-party children
        // make it fail closed instead of being deleted recursively.
        await rmdir(entry.path).catch(() => {})
      }
    } catch {
      // A missing or unreadable path is no longer safe for rollback to own.
    }
  }
}

async function publishDirectoryNoClobber(
  sourcePath: string,
  destinationPath: string,
  publishedEntries: PublishedEntry[],
  signal?: AbortSignal
): Promise<void> {
  await mkdir(destinationPath, { recursive: false })
  // Why: capture the directory identity synchronously after the exclusive
  // claim so no async gap exists before rollback ownership is registered.
  const destinationStats = lstatSync(destinationPath, { bigint: true })
  publishedEntries.push(publishedEntryFromStats('directory', destinationPath, destinationStats))
  const entries = (await readdir(sourcePath, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (const entry of entries) {
    signal?.throwIfAborted()
    const sourceEntryPath = join(sourcePath, entry.name)
    const destinationEntryPath = join(destinationPath, entry.name)
    if (entry.isDirectory()) {
      await publishDirectoryNoClobber(
        sourceEntryPath,
        destinationEntryPath,
        publishedEntries,
        signal
      )
    } else if (entry.isFile()) {
      await publishTrackedFileNoClobber(
        sourceEntryPath,
        destinationEntryPath,
        publishedEntries,
        signal
      )
    } else {
      throw new Error(`Unexpected local download entry '${entry.name}'`)
    }
    signal?.throwIfAborted()
  }
  signal?.throwIfAborted()
}

export async function promoteLocalDownloadedFolder(
  tempPath: string,
  destinationPath: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const publishedEntries: PublishedEntry[] = []
  try {
    // Why: Node has no portable atomic no-replace directory rename. Claiming
    // the destination first preserves no-clobber while promotion stays local.
    await publishDirectoryNoClobber(tempPath, destinationPath, publishedEntries, signal)
  } catch (error) {
    await rollbackPublishedEntries(publishedEntries)
    if (isEEXIST(error)) {
      throw new Error('Destination folder already exists')
    }
    throw error
  }
  await rm(tempPath, { recursive: true, force: true }).catch(() => {})
}
