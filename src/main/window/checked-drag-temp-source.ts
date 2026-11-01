import { createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'
import type {
  DragTempCopyBatch,
  DragTempCopyEnvironment,
  DragTempCopyItemResult
} from './dragged-temp-file-copy'
import { ensureOwnedTempStagingRoot } from './owned-temp-staging-root'

const COPY_DIR_PREFIX = 'orca-drop-'
const COPY_HIGH_WATER_MARK = 1024 * 1024

/** A checked drag-temp file: the handle reads the dropped bytes even after the provider removes
 *  the path, and every write compares it against the snapshot taken when it was opened. */
export type CheckedDragTempSource = {
  sourcePath: string
  name: string
  handle: FileHandle
  snapshot: Stats
  size: number
}

export async function readCheckedDragTempSourceBytes(
  source: CheckedDragTempSource,
  signal?: AbortSignal
): Promise<Buffer> {
  const read = await readNodeFileHandleWithinLimit(
    source.handle,
    AGENT_SESSION_ATTACHMENT_MAX_BYTES,
    {
      regularFileOnly: true,
      signal,
      window: { offset: 0, length: source.size }
    }
  ).finally(async () => {
    if (!isSameSnapshot(await source.handle.stat(), source.snapshot)) {
      throw new DropCopyError('changed')
    }
  })
  if (!isSameSnapshot(read.stats, source.snapshot)) {
    throw new DropCopyError('changed')
  }
  return read.buffer
}

/** Copies the checked source into `destPath` from offset 0, then proves the bytes are the ones
 *  opened: written size and the handle's stat must still match the open-time snapshot. */
export async function writeCheckedDragTempSource(
  source: CheckedDragTempSource,
  destPath: string,
  signal?: AbortSignal
): Promise<void> {
  // Reading bytes from the checked handle copies no xattrs, unlike cp, ditto or clonefile.
  if (source.size <= AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
    const bytes = await readCheckedDragTempSourceBytes(source, signal)
    await writeFile(destPath, bytes, { flag: 'wx', mode: 0o600, signal })
    // The bytes are in memory and already proven against the source snapshot.
    return
  }
  await pipeline(
    readCheckedDragTempSource(source),
    createWriteStream(destPath, {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: COPY_HIGH_WATER_MARK
    }),
    { signal }
  )
  const written = await lstat(destPath)
  if (
    written.size !== source.size ||
    !isSameSnapshot(await source.handle.stat(), source.snapshot)
  ) {
    throw new DropCopyError('changed')
  }
}

// The pipeline owns the iterator, while the batch keeps the handle for a fallback write.
async function* readCheckedDragTempSource(source: CheckedDragTempSource): AsyncGenerator<Buffer> {
  for (let position = 0; position < source.size;) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_HIGH_WATER_MARK, source.size - position))
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) {
      return
    }
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

export function isDragTempSourceChanged(error: unknown): boolean {
  return error instanceof DropCopyError && error.reason === 'changed'
}

/** A private 0600 copy in Orca's temp storage, for consumers that need a path. */
export async function copyCheckedDragTempSource(
  source: CheckedDragTempSource,
  env: DragTempCopyEnvironment,
  batch: DragTempCopyBatch,
  signal?: AbortSignal
): Promise<DragTempCopyItemResult> {
  let directory: string | undefined
  try {
    directory = await createCopyDirectory(env.copyRoot, batch)
    signal?.throwIfAborted()
    const destPath = join(directory, source.name)
    await writeCheckedDragTempSource(source, destPath, signal)
    // Why: a caller that gave up mid-copy never hands this path out; don't retain it.
    signal?.throwIfAborted()
    console.debug('[drop] copied a drag-temp file into Orca storage', { bytes: source.size })
    return {
      sourcePath: source.sourcePath,
      status: 'imported',
      destPath,
      byteLength: source.size,
      directory
    }
  } catch (error) {
    if (directory) {
      // Why: cleanup must not hide the original failure or stop later items.
      batch.directories.delete(directory)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    if (signal?.aborted) {
      throw error
    }
    return classifyFailure(source.sourcePath, error)
  }
}

export async function stageCapturedDragTempBytes(
  sourcePath: string,
  bytes: Buffer,
  env: DragTempCopyEnvironment,
  batch: DragTempCopyBatch,
  signal?: AbortSignal
): Promise<DragTempCopyItemResult> {
  let directory: string | undefined
  try {
    signal?.throwIfAborted()
    directory = await createCopyDirectory(env.copyRoot, batch)
    signal?.throwIfAborted()
    const destPath = join(directory, basename(sourcePath))
    await writeFile(destPath, bytes, { flag: 'wx', mode: 0o600, signal })
    signal?.throwIfAborted()
    return { sourcePath, status: 'imported', destPath, byteLength: bytes.length, directory }
  } catch (error) {
    if (directory) {
      batch.directories.delete(directory)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    signal?.throwIfAborted()
    return classifyFailure(sourcePath, error)
  }
}

async function createCopyDirectory(copyRoot: string, batch: DragTempCopyBatch): Promise<string> {
  try {
    if (!(await ensureOwnedTempStagingRoot(copyRoot))) {
      throw new DropCopyError('storage-not-private')
    }
    const directory = await mkdtemp(join(copyRoot, COPY_DIR_PREFIX))
    batch.directories.add(directory)
    return directory
  } catch (error) {
    if (error instanceof DropCopyError) {
      throw error
    }
    // Why: a storage fault must not read as a missing or unreadable dropped file.
    console.warn('[drop] could not create drop storage', { code: errorCode(error) })
    throw new DropCopyError(isOutOfSpace(errorCode(error)) ? 'out-of-space' : 'storage-unavailable')
  }
}

/** Same inode, size and mtime, where the filesystem reports an inode. */
export function isSameSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

export class DropCopyError extends Error {
  constructor(readonly reason: NativeFileDropCopyFailureReason) {
    super(reason)
  }
}

export function classifyFailure(sourcePath: string, error: unknown): DragTempCopyItemResult {
  return { sourcePath, status: 'failed', reason: failureReason(error) }
}

function isOutOfSpace(code: string | undefined): boolean {
  return code === 'ENOSPC' || code === 'EDQUOT'
}

function failureReason(error: unknown): NativeFileDropCopyFailureReason {
  if (error instanceof DropCopyError) {
    return error.reason
  }
  const code = errorCode(error)
  if (code === 'ENOENT') {
    return 'missing'
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return 'permission-denied'
  }
  console.warn('[drop] could not copy a drag-temp file', { code })
  return isOutOfSpace(code) ? 'out-of-space' : 'copy-failed'
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
