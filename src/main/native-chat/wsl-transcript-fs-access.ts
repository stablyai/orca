import { createReadStream, type Dirent, type Stats } from 'node:fs'
import { lstat, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isWslUncPath } from '../../shared/wsl-paths'
import { runWslTranscriptFsTask, type WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import { wslTranscriptFsRouteKey } from './wsl-transcript-fs-route'

/** Never nest a gated call inside another — that deadlocks the scan slot. */

// Why: one deadline per chunk instead of one for the whole file, so a large
// healthy-but-slow transcript is not false-failed by a whole-file timeout.
export const WSL_TRANSCRIPT_READ_CHUNK_BYTES = 1024 * 1024
type Operation = Parameters<typeof runWslTranscriptFsTask>[0]['operation']

function runPathOperation<T>(
  operation: Operation,
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
  options?: { dedupe?: boolean; onAbandonedResult?: (value: T) => void }
): Promise<T> {
  return isWslUncPath(path)
    ? runWslTranscriptFsTask({ operation, path, priority, signal, ...options }, task)
    : task()
}

export function wslGatedStat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runPathOperation('stat', path, priority, signal, () => stat(path))
}

export function wslGatedLstat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runPathOperation('lstat', path, priority, signal, () => lstat(path))
}

export function wslGatedReaddir(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Dirent[]> {
  return runPathOperation('readdir', path, priority, signal, () =>
    readdir(path, { withFileTypes: true })
  )
}

export function wslGatedReadFile(
  path: string,
  encoding: BufferEncoding,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<string> {
  return runPathOperation('readfile', path, priority, signal, () => readFile(path, encoding))
}

// dedupe:false — two joiners would share one FileHandle and both close it.
export function wslGatedOpen(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<FileHandle> {
  return runPathOperation('open', path, priority, signal, () => open(path, 'r'), {
    dedupe: false,
    // An unabortable open can still succeed after its caller timed out or
    // cancelled; without this the descriptor leaks for the process lifetime.
    onAbandonedResult: (handle) => void closeTranscriptHandle(handle, path)
  })
}

/**
 * `path` is only the gate's route key and UNC guard — the handle carries no
 * path and is never re-opened. dedupe:false because `read` fills the CALLER's
 * buffer: a joiner would receive the first caller's buffer while its own
 * (often `Buffer.allocUnsafe`) stays uninitialized.
 */
export function wslGatedRead(
  handle: FileHandle,
  path: string,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<{ bytesRead: number; buffer: Buffer }> {
  return runPathOperation(
    'read',
    path,
    priority,
    signal,
    () => handle.read(buffer, offset, length, position),
    { dedupe: false }
  )
}

// A blocked `uv_fs_close` holds a libuv threadpool thread just like a blocked
// read does, but it is invisible to the gate — so UNC teardown drains one handle
// at a time. Unbounded fire-and-forget closes are what would exhaust the pool the
// gate's two permits are sized against, re-creating the process-wide stall the
// gate exists to prevent; serializing them costs at most one extra busy thread.
// The queue cannot grow without bound: opens on a stuck route already fast-fail.
// Keyed by route like the gate's own admission, because a close that blocks on a
// stalled distro never settles — a shared queue would strand every later close,
// including handles on healthy distros, for the process lifetime.
const MAX_CONCURRENT_UNC_CLOSES_PER_ROUTE = 1
type RouteCloseQueue = { queued: FileHandle[]; active: number }
const closeQueuesByRoute = new Map<string, RouteCloseQueue>()

function drainQueuedCloses(route: string): void {
  const lane = closeQueuesByRoute.get(route)
  if (!lane) {
    return
  }
  while (lane.active < MAX_CONCURRENT_UNC_CLOSES_PER_ROUTE) {
    const handle = lane.queued.shift()
    if (!handle) {
      if (lane.active === 0) {
        closeQueuesByRoute.delete(route)
      }
      return
    }
    lane.active += 1
    void handle
      .close()
      .catch(() => {})
      .finally(() => {
        lane.active -= 1
        drainQueuedCloses(route)
      })
  }
}

/**
 * Never gated. Off UNC this is the prior contract verbatim — the caller awaits
 * fd teardown and a close failure surfaces. On UNC it is fire-and-forget:
 * closing a handle on a stalled mount can itself block, and a gated close would
 * burn a permit and a waiter deadline purely for teardown. One leaked fd until
 * the OS unblocks beats a second blocked waiter.
 */
export function closeTranscriptHandle(handle: FileHandle, path: string): Promise<void> {
  if (!isWslUncPath(path)) {
    return handle.close()
  }
  const route = wslTranscriptFsRouteKey(path)
  const lane = closeQueuesByRoute.get(route) ?? { queued: [], active: 0 }
  closeQueuesByRoute.set(route, lane)
  lane.queued.push(handle)
  drainQueuedCloses(route)
  return Promise.resolve()
}

/**
 * Open, read one slice, close — for callers that want bytes at an offset and
 * never touch the handle. Each of the two syscalls is admitted separately, so a
 * stalled mount fails at whichever one it blocks on.
 */
export async function readTranscriptSlice(
  path: string,
  position: number,
  length: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Buffer> {
  const handle = await wslGatedOpen(path, priority, signal)
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await wslGatedRead(
      handle,
      path,
      buffer,
      0,
      length,
      position,
      priority,
      signal
    )
    return buffer.subarray(0, bytesRead)
  } finally {
    await closeTranscriptHandle(handle, path)
  }
}

export type TranscriptReadStreamOptions = {
  start?: number
  /** Inclusive, matching `createReadStream`. */
  end?: number
  /** Set it to get decoded string chunks on both branches; leave it unset and
   *  the UNC branch yields `Buffer`s the consumer must decode incrementally
   *  itself, since a chunk boundary can split a multibyte codepoint. */
  encoding?: BufferEncoding
}

async function* gatedChunks(
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): AsyncGenerator<Buffer | string> {
  const handle = await wslGatedOpen(path, priority, signal)
  // Why: chunk boundaries fall mid-codepoint, so decoding each slice
  // independently would emit U+FFFD on both sides of any straddling character.
  const decoder = options.encoding ? new StringDecoder(options.encoding) : null
  try {
    let position = options.start ?? 0
    for (;;) {
      const length =
        options.end === undefined
          ? WSL_TRANSCRIPT_READ_CHUNK_BYTES
          : Math.min(WSL_TRANSCRIPT_READ_CHUNK_BYTES, options.end - position + 1)
      if (length <= 0) {
        break
      }
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await wslGatedRead(
        handle,
        path,
        buffer,
        0,
        length,
        position,
        priority,
        signal
      )
      if (bytesRead <= 0) {
        break
      }
      position += bytesRead
      const chunk = buffer.subarray(0, bytesRead)
      if (!decoder) {
        yield chunk
        continue
      }
      const decoded = decoder.write(chunk)
      if (decoded) {
        yield decoded
      }
    }
    // Trailing bytes of an incomplete sequence at EOF, replacement-char'd once.
    const trailing = decoder?.end()
    if (trailing) {
      yield trailing
    }
  } finally {
    // Runs on `.destroy()` too (Readable.from calls the generator's return()),
    // so an aborted head-read cannot leak the gated handle.
    await closeTranscriptHandle(handle, path)
  }
}

/**
 * A read stream whose UNC branch admits and deadlines each 1 MiB chunk
 * separately. A gate refusal mid-stream surfaces as an `'error'` event carrying
 * the `WslTranscriptFsError`, which every existing consumer funnels into its
 * `catch`.
 */
export function openTranscriptReadStream(
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Readable {
  if (!isWslUncPath(path)) {
    // Node destroys the stream with an AbortError on abort, matching how the
    // gated branch surfaces cancellation to the same consumers.
    return createReadStream(path, { ...options, signal })
  }
  return Readable.from(gatedChunks(path, options, priority, signal))
}
