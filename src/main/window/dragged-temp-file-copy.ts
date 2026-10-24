import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../ipc/runtime-import-limits'
import {
  hasDragTempMarker,
  isPathWithin,
  mayNeedDragTempCopy,
  relativeSegments
} from './drag-temp-path'
import { getOwnedTempStagingRoot } from './owned-temp-staging-root'
import {
  classifyFailure,
  copyCheckedDragTempSource,
  DropCopyError,
  errorCode,
  isSameSnapshot,
  type CheckedDragTempSource
} from './checked-drag-temp-source'

// Why: macOS screenshot thumbnails live in `$TMPDIR/TemporaryItems/NSIRD_*`,
// which only processes attributed to Orca main may open. The detached PTY
// daemon is not, so agents in local terminals get EPERM on the original path.

const DRAG_TEMP_COPY_ROOT_NAME = 'orca-drops'
// Why no expiry: a copy may be what a terminal agent, a draft or a sent message still names, and
// nothing tells which; a local chat's drop is written straight into its chat store instead.

export type DragTempCopyEnvironment = {
  platform: NodeJS.Platform
  /** macOS per-user temp dir: where drag providers put their files. */
  sourceTempRoot: string
  /** Orca-owned directory that holds one `orca-drop-*` directory per copy. */
  copyRoot: string
}

export type DragTempCopyItemResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      byteLength?: number
      directory?: string
    }
  /** Checked and held open, unread: a local chat writes it straight into its store. */
  | { sourcePath: string; status: 'opened'; source: CheckedDragTempSource }
  /** Left as the original path, which only main's children can open. */
  | { sourcePath: string; status: 'uncopied'; reason: 'too-large' | 'storage-full' }
  | { sourcePath: string; status: 'failed'; reason: NativeFileDropCopyFailureReason }

export class DragTempCopyBatch {
  readonly completed = new Map<string, DragTempCopyItemResult>()
  readonly directories = new Set<string>()
  readonly opened = new Set<CheckedDragTempSource>()
  /** Files at or under this size are held open instead of copied; -1 for none. */
  constructor(readonly openMaxBytes = -1) {}
}

export function getDragTempCopyRoot(appTempRoot: string): string {
  return getOwnedTempStagingRoot(appTempRoot, DRAG_TEMP_COPY_ROOT_NAME)
}

/**
 * Copy every drag-temp path in a drop into Orca-owned storage, sequentially,
 * within the per-drop byte budget. Other paths pass through unchanged.
 */
export async function materializeDragTempPaths(
  paths: readonly string[],
  env: DragTempCopyEnvironment,
  signal?: AbortSignal,
  batch = new DragTempCopyBatch()
): Promise<DragTempCopyItemResult[]> {
  const { completed } = batch
  // Why per drop: copies are never swept, so earlier drops must not refuse later ones.
  let remainingBytes = env.platform === 'darwin' ? REMOTE_IMPORT_MAX_TOTAL_BYTES : 0
  try {
    for (const sourcePath of paths) {
      signal?.throwIfAborted()
      if (completed.has(sourcePath)) {
        continue
      }
      const capture = await materializeDragTempPath(sourcePath, remainingBytes, env, signal, batch)
      remainingBytes -= capture.copiedBytes
      completed.set(sourcePath, capture.result)
    }
    signal?.throwIfAborted()
    return paths.map((path) => completed.get(path)!)
  } catch (error) {
    completed.clear()
    await releaseDragTempBatch(batch)
    throw error
  }
}

/** Closes every source still held open and removes the copies this batch created. */
export async function releaseDragTempBatch(batch: DragTempCopyBatch): Promise<void> {
  for (const source of batch.opened) {
    await closeDragTempSource(batch, source)
  }
  await removeCreatedDragTempCopies(batch.directories)
}

export async function closeDragTempSource(
  batch: DragTempCopyBatch,
  source: CheckedDragTempSource
): Promise<void> {
  if (batch.opened.delete(source)) {
    await source.handle.close().catch(() => undefined)
  }
}

export async function removeCreatedDragTempCopies(directories: Iterable<string>): Promise<void> {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function materializeDragTempPath(
  sourcePath: string,
  remainingBytes: number,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal,
  batch = new DragTempCopyBatch()
): Promise<{ result: DragTempCopyItemResult; copiedBytes: number }> {
  const passThrough = { result: imported(sourcePath, sourcePath), copiedBytes: 0 }
  if (!mayNeedDragTempCopy(sourcePath, env.platform)) {
    return passThrough
  }
  try {
    let inspected: Stats
    try {
      inspected = await lstat(sourcePath)
    } catch (error) {
      // A missing lookalike outside `$TMPDIR` is still an ordinary path.
      if (
        errorCode(error) === 'ENOENT' &&
        !isPathWithin(resolve(env.sourceTempRoot), resolve(sourcePath))
      ) {
        return passThrough
      }
      throw error
    }
    if (!inspected.isFile()) {
      // Why: directories and symlinks keep today's reference-in-place behaviour.
      return passThrough
    }
    const canonicalSource = await realpath(sourcePath)
    const canonicalTempRoot = await realpath(env.sourceTempRoot)
    if (!hasDragTempMarker(relativeSegments(canonicalTempRoot, canonicalSource))) {
      return passThrough
    }

    const handle = await open(canonicalSource, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let heldOpen = false
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || !isSameSnapshot(opened, inspected)) {
        throw new DropCopyError('changed')
      }
      const size = opened.size
      if (size > REMOTE_IMPORT_MAX_FILE_BYTES || size > remainingBytes) {
        // Why: targets read by main can still use the original; the relay decides.
        console.warn('[drop] leaving a drag-temp file uncopied: over the copy budget', {
          bytes: formatByteCeiling(size),
          remaining: formatByteCeiling(Math.max(remainingBytes, 0))
        })
        const reason = size > REMOTE_IMPORT_MAX_FILE_BYTES ? 'too-large' : 'storage-full'
        return { result: { sourcePath, status: 'uncopied', reason }, copiedBytes: 0 }
      }
      signal?.throwIfAborted()
      const source: CheckedDragTempSource = {
        sourcePath,
        name: basename(canonicalSource),
        handle,
        snapshot: opened,
        size
      }
      if (size <= batch.openMaxBytes) {
        // Why unread: the chat store writes it once, straight from this handle.
        heldOpen = true
        batch.opened.add(source)
        return { result: { sourcePath, status: 'opened', source }, copiedBytes: size }
      }
      const result = await copyCheckedDragTempSource(source, env, batch, signal)
      return { result, copiedBytes: result.status === 'imported' ? size : 0 }
    } finally {
      if (!heldOpen) {
        await handle.close()
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return { result: classifyFailure(sourcePath, error), copiedBytes: 0 }
  }
}

function imported(sourcePath: string, destPath: string): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}
