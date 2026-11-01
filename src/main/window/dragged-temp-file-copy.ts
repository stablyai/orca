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
  readCheckedDragTempSourceBytes,
  type CheckedDragTempSource
} from './checked-drag-temp-source'

// macOS drag thumbnails require Orca-main TCC attribution; detached PTY daemons get EPERM on TemporaryItems/NSIRD_* originals.

const DRAG_TEMP_COPY_ROOT_NAME = 'orca-drops'
// No expiry: terminal agents/drafts/messages may still name copies without ownership signals. A local chat's drop goes straight into its chat store instead.

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
  | { sourcePath: string; status: 'buffered'; bytes: Buffer }
  /** Left as the original path, which only main's children can open. */
  | { sourcePath: string; status: 'uncopied'; reason: 'too-large' | 'storage-full' }
  | { sourcePath: string; status: 'failed'; reason: NativeFileDropCopyFailureReason }

export class DragTempCopyBatch {
  readonly completed = new Map<string, DragTempCopyItemResult>()
  readonly directories = new Set<string>()
  readonly opened = new Set<CheckedDragTempSource>()
  remainingMemory: number
  /** Local-chat file cap and initial batch memory budget; -1 disables both. */
  constructor(readonly openMaxBytes = -1) {
    this.remainingMemory = openMaxBytes
  }
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
  // Budget per drop; retained earlier copies must not block later drops.
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
      // Keep directories/symlinks referenced in place.
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
        // Main-attributed targets can still use the original; let the relay decide.
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
      if (size <= batch.remainingMemory) {
        const bytes = await readCheckedDragTempSourceBytes(source, signal)
        signal?.throwIfAborted()
        batch.remainingMemory -= size
        return { result: { sourcePath, status: 'buffered', bytes }, copiedBytes: size }
      }
      if (size <= batch.openMaxBytes) {
        // Left unread: the chat store writes it once, straight from this handle.
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
