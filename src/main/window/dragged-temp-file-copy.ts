import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../ipc/runtime-import-limits'
import { ensureOwnedTempStagingRoot, getOwnedTempStagingRoot } from './owned-temp-staging-root'

// macOS drag thumbnails require Orca-main TCC attribution; detached PTY daemons get EPERM on TemporaryItems/NSIRD_* originals.

const TEMPORARY_ITEMS_SEGMENT = 'TemporaryItems'
const DRAG_PROVIDER_DIR_PREFIX = 'NSIRD_'
const COPY_DIR_PREFIX = 'orca-drop-'
const DRAG_TEMP_COPY_ROOT_NAME = 'orca-drops'
// No expiry: terminal agents/drafts/messages may still name copies without ownership signals. New structured-chat copies enter the chat store before publication.

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
  | { sourcePath: string; status: 'buffered'; bytes: Buffer }
  /** Left as the original path, which only main's children can open. */
  | { sourcePath: string; status: 'uncopied'; reason: 'too-large' | 'storage-full' }
  | { sourcePath: string; status: 'failed'; reason: NativeFileDropCopyFailureReason }

export class DragTempCopyBatch {
  readonly completed = new Map<string, DragTempCopyItemResult>()
  readonly directories = new Set<string>()
  constructor(public remainingMemory = -1) {}
}

export function getDragTempCopyRoot(appTempRoot: string): string {
  return getOwnedTempStagingRoot(appTempRoot, DRAG_TEMP_COPY_ROOT_NAME)
}

/** Lexical check only: whether a path could be a drag-temp file worth inspecting. */
export function mayNeedDragTempCopy(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && hasDragTempMarker(resolve(path).split(sep))
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
      let capture = await materializeDragTempPath(sourcePath, remainingBytes, env, signal, batch)
      while (!capture) {
        batch.remainingMemory = -1
        for (const [path, result] of completed) {
          if (result.status === 'buffered') {
            const staged = await stageCapturedDragTempBytes(path, result.bytes, env, batch, signal)
            completed.set(path, staged)
            if (staged.status === 'failed') {
              remainingBytes += result.bytes.length
            }
          }
        }
        // Spill waits invalidate prospective provider stats: acquire it normally again.
        capture = await materializeDragTempPath(sourcePath, remainingBytes, env, signal, batch)
      }
      remainingBytes -= capture.copiedBytes
      completed.set(sourcePath, capture.result)
    }
    signal?.throwIfAborted()
    return paths.map((path) => completed.get(path)!)
  } catch (error) {
    completed.clear()
    await removeCreatedDragTempCopies(batch.directories)
    throw error
  }
}

export async function removeCreatedDragTempCopies(directories: Iterable<string>): Promise<void> {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
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
    if ((await lstat(destPath)).size !== bytes.length) {
      throw new DropCopyError('changed')
    }
    signal?.throwIfAborted()
    return { sourcePath, status: 'imported', destPath, byteLength: bytes.length, directory }
  } catch (error) {
    if (directory) {
      await removeCreatedDragTempCopies([directory])
    }
    signal?.throwIfAborted()
    return classifyFailure(sourcePath, error)
  }
}

export async function materializeDragTempPath(
  sourcePath: string,
  remainingBytes: number,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal,
  batch = new DragTempCopyBatch()
): Promise<{ result: DragTempCopyItemResult; copiedBytes: number } | null> {
  const passThrough = { result: imported(sourcePath, sourcePath), copiedBytes: 0 }
  if (!mayNeedDragTempCopy(sourcePath, env.platform)) {
    return passThrough
  }
  let copyDir: string | undefined
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

      if (batch.remainingMemory >= 0) {
        if (size > batch.remainingMemory) {
          return null
        }
        const read = await readNodeFileHandleWithinLimit(
          handle,
          AGENT_SESSION_ATTACHMENT_MAX_BYTES,
          {
            regularFileOnly: true,
            signal,
            window: { offset: 0, length: size }
          }
        )
        if (!isSameSnapshot(read.stats, opened) || !isSameSnapshot(await handle.stat(), opened)) {
          throw new DropCopyError('changed')
        }
        signal?.throwIfAborted()
        batch.remainingMemory -= size
        return { result: { sourcePath, status: 'buffered', bytes: read.buffer }, copiedBytes: size }
      }
      copyDir = await createCopyDirectory(env.copyRoot, batch)
      signal?.throwIfAborted()
      const destPath = join(copyDir, basename(canonicalSource))
      // Copy from the checked handle, capped at inspected size, without xattrs. Empty files need a separate branch because stream end:-1 throws.
      await (size === 0
        ? writeFile(destPath, '', { flag: 'wx', mode: 0o600 })
        : pipeline(
            handle.createReadStream({ start: 0, end: size - 1, autoClose: false }),
            createWriteStream(destPath, { flags: 'wx', mode: 0o600 }),
            { signal }
          ))
      const written = await lstat(destPath)
      const afterRead = await handle.stat()
      if (written.size !== size || !isSameSnapshot(afterRead, opened)) {
        throw new DropCopyError('changed')
      }
      // Abort before publishing the path so abandoned copies can be removed.
      signal?.throwIfAborted()
      console.debug('[drop] copied a drag-temp file into Orca storage', { bytes: size })
      return {
        result: { sourcePath, status: 'imported', destPath, byteLength: size, directory: copyDir },
        copiedBytes: size
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (copyDir) {
      // Cleanup must preserve the original failure and allow later items.
      await rm(copyDir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (signal?.aborted) {
      throw error
    }
    return { result: classifyFailure(sourcePath, error), copiedBytes: 0 }
  }
}

// True when the segments hold `TemporaryItems/NSIRD_*/<entry>`: something below the provider dir.
function hasDragTempMarker(segments: readonly string[]): boolean {
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] === TEMPORARY_ITEMS_SEGMENT &&
      segments[i + 1].startsWith(DRAG_PROVIDER_DIR_PREFIX)
    ) {
      return true
    }
  }
  return false
}

/** Path segments of `candidate` below `root`, or [] when it is not inside it. */
function relativeSegments(root: string, candidate: string): string[] {
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return []
  }
  const segments = rel.split(sep)
  // Anchor at the real temp root; never copy lookalike paths elsewhere.
  return segments[0] === TEMPORARY_ITEMS_SEGMENT ? segments : []
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
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
    // Distinguish storage faults from missing/unreadable sources.
    console.warn('[drop] could not create drop storage', { code: errorCode(error) })
    throw new DropCopyError(isOutOfSpace(errorCode(error)) ? 'out-of-space' : 'storage-unavailable')
  }
}

/** Same inode, size and mtime, where the filesystem reports an inode. */
function isSameSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

function imported(sourcePath: string, destPath: string): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}

class DropCopyError extends Error {
  constructor(readonly reason: NativeFileDropCopyFailureReason) {
    super(reason)
  }
}

function classifyFailure(sourcePath: string, error: unknown): DragTempCopyItemResult {
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

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
