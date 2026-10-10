import { constants, createWriteStream, type Dir, type Stats } from 'node:fs'
import { lstat, mkdtemp, open, opendir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../ipc/runtime-import-limits'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot,
  isSafeOwnedDirectory,
  sweepExpiredOwnedDirectories
} from './owned-temp-staging-root'

// Why: macOS screenshot thumbnails live in `$TMPDIR/TemporaryItems/NSIRD_*`,
// which only processes attributed to Orca main may open. The detached PTY
// daemon is not, so agents in local terminals get EPERM on the original path.

const TEMPORARY_ITEMS_SEGMENT = 'TemporaryItems'
const DRAG_PROVIDER_DIR_PREFIX = 'NSIRD_'
const COPY_ROOT_NAME = 'orca-drops'
const COPY_DIR_PREFIX = 'orca-drop-'
const COPY_DIR_PATTERN = /^orca-drop-[A-Za-z0-9]{6}$/
// Why: open drafts and startup prompts read the copy lazily, often days later, so
// keep it well past the drop; the TTL still bounds what the copy budget holds.
export const DRAG_TEMP_COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_FIRST_DELAY_MS = 30 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export type DragTempCopyEnvironment = {
  platform: NodeJS.Platform
  /** macOS per-user temp dir: where drag providers put their files. */
  sourceTempRoot: string
  /** Orca-owned directory that holds one `orca-drop-*` directory per copy. */
  copyRoot: string
}

export type DragTempCopyItemResult =
  | { sourcePath: string; status: 'imported'; destPath: string }
  /** Left as the original path, which only main's children can open. */
  | { sourcePath: string; status: 'uncopied'; reason: 'too-large' | 'storage-full' }
  | { sourcePath: string; status: 'failed'; reason: NativeFileDropCopyFailureReason }

export function getDragTempCopyRoot(appTempRoot: string): string {
  return getOwnedTempStagingRoot(appTempRoot, COPY_ROOT_NAME)
}

/** Lexical check only: whether a path could be a drag-temp file worth inspecting. */
export function mayNeedDragTempCopy(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && hasDragTempMarker(resolve(path).split(sep))
}

/**
 * Copy every drag-temp path in a drop into Orca-owned storage, sequentially,
 * under the byte budget storage has left. Other paths pass through unchanged.
 */
export async function materializeDragTempPaths(
  paths: readonly string[],
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<DragTempCopyItemResult[]> {
  const results: DragTempCopyItemResult[] = []
  const completed = new Map<string, DragTempCopyItemResult>()
  // Why: the budget spans every retained copy, so repeated drops cannot fill the disk.
  let remainingBytes =
    env.platform === 'darwin'
      ? REMOTE_IMPORT_MAX_TOTAL_BYTES - (await measureRetainedCopyBytes(env.copyRoot))
      : 0
  try {
    for (const sourcePath of paths) {
      signal?.throwIfAborted()
      // Why: reuse one copy so composer de-duplication still sees equal paths.
      const previous = completed.get(sourcePath)
      if (previous) {
        results.push(previous)
        continue
      }
      const { result, copiedBytes } = await materializeDragTempPath(
        sourcePath,
        remainingBytes,
        env,
        signal
      )
      remainingBytes -= copiedBytes
      completed.set(sourcePath, result)
      results.push(result)
    }
    signal?.throwIfAborted()
    return results
  } catch (error) {
    // Why: a caller that gave up never hands these out; don't hold budget until the sweep.
    await removeCopies(completed.values())
    throw error
  }
}

async function removeCopies(results: Iterable<DragTempCopyItemResult>): Promise<void> {
  for (const result of results) {
    if (result.status === 'imported' && result.destPath !== result.sourcePath) {
      await rm(dirname(result.destPath), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function materializeDragTempPath(
  sourcePath: string,
  remainingBytes: number,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<{ result: DragTempCopyItemResult; copiedBytes: number }> {
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
      // Why: directories and symlinks keep today's reference-in-place behaviour.
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
        // Why: targets read by main can still use the original; the relay decides.
        console.warn('[drop] leaving a drag-temp file uncopied: over the copy budget', {
          bytes: formatByteCeiling(size),
          remaining: formatByteCeiling(Math.max(remainingBytes, 0))
        })
        const reason = size > REMOTE_IMPORT_MAX_FILE_BYTES ? 'too-large' : 'storage-full'
        return { result: { sourcePath, status: 'uncopied', reason }, copiedBytes: 0 }
      }
      signal?.throwIfAborted()

      copyDir = await createCopyDirectory(env.copyRoot)
      const destPath = join(copyDir, basename(canonicalSource))
      // Why: stream from the checked handle, capped at the inspected size, so a
      // swapped or growing source cannot slip through; unlike cp, ditto or
      // clonefile it copies no xattrs. A read stream with `end: -1` throws, so
      // an empty source gets its own branch.
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
      // Why: a caller that gave up mid-copy never hands this path out; don't retain it.
      signal?.throwIfAborted()
      console.debug('[drop] copied a drag-temp file into Orca storage', { bytes: size })
      return { result: imported(sourcePath, destPath), copiedBytes: size }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (copyDir) {
      // Why: cleanup must not hide the original failure or stop later items.
      await rm(copyDir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (signal?.aborted) {
      throw error
    }
    return { result: classifyFailure(sourcePath, error), copiedBytes: 0 }
  }
}

/** Remove `orca-drop-*` copies older than the TTL; younger ones may still be read lazily. */
export async function sweepExpiredDragTempCopies(
  copyRoot: string,
  nowMs = Date.now()
): Promise<void> {
  try {
    if (!isSafeOwnedDirectory(await lstat(copyRoot))) {
      return
    }
  } catch {
    // Missing or unreadable root: nothing of ours to sweep.
    return
  }
  await sweepExpiredOwnedDirectories(copyRoot, {
    nowMs,
    ttlMs: DRAG_TEMP_COPY_TTL_MS,
    ownsEntry: (name) => COPY_DIR_PATTERN.test(name)
  })
}

/** Bytes held by `orca-drop-*` copies still on disk; unreadable entries count as zero. */
async function measureRetainedCopyBytes(copyRoot: string): Promise<number> {
  let total = 0
  let rootDir: Dir
  try {
    rootDir = await opendir(copyRoot)
  } catch {
    return 0
  }
  try {
    for await (const entry of rootDir) {
      if (!entry.isDirectory() || !COPY_DIR_PATTERN.test(entry.name)) {
        continue
      }
      const copyDir = join(copyRoot, entry.name)
      const names = await readdir(copyDir).catch(() => [])
      for (const name of names) {
        total += await lstat(join(copyDir, name)).then(
          (stats) => (stats.isFile() ? stats.size : 0),
          () => 0
        )
      }
    }
  } catch {
    // A partial count still bounds growth; the next drop measures again.
  }
  return total
}

let sweepScheduled = false

/** Sweep shortly after startup, then hourly, so a long-running app still expires copies. */
export function scheduleDragTempCopySweep(
  getCopyRoot: () => string,
  platform: NodeJS.Platform = process.platform
): void {
  if (sweepScheduled || platform !== 'darwin') {
    return
  }
  sweepScheduled = true
  const sweep = (): void => {
    void Promise.resolve()
      .then(() => sweepExpiredDragTempCopies(getCopyRoot()))
      .catch(() => undefined)
  }
  setTimeout(sweep, SWEEP_FIRST_DELAY_MS).unref()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()
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
  // Why: anchor at the temp root so a nested lookalike elsewhere is not copied.
  return segments[0] === TEMPORARY_ITEMS_SEGMENT ? segments : []
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function createCopyDirectory(copyRoot: string): Promise<string> {
  try {
    if (!(await ensureOwnedTempStagingRoot(copyRoot))) {
      throw new DropCopyError('storage-not-private')
    }
    return await mkdtemp(join(copyRoot, COPY_DIR_PREFIX))
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
