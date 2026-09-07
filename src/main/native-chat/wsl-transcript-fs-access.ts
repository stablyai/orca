import { createReadStream, type Dirent, type Stats } from 'node:fs'
import { access, lstat, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isWslUncPath } from '../../shared/wsl-paths'
import { runWslTranscriptFsTask, type WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import {
  closeWslTranscriptFsProcess,
  isWslTranscriptFsProcessHandle,
  openWslTranscriptFsProcess,
  readWslTranscriptFsProcess,
  runWslTranscriptFsProcess,
  type WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-dispatch'
import type { WslTranscriptFsReusableProcessCall } from './wsl-transcript-fs-process-protocol'
import { wslTranscriptFsLaneKey } from './wsl-transcript-fs-route'

/** Never nest a gated call inside another — that deadlocks the scan slot. */

// Why: one deadline per chunk instead of one for the whole file, so a large
// healthy-but-slow transcript is not false-failed by a whole-file timeout.
export const WSL_TRANSCRIPT_READ_CHUNK_BYTES = 1024 * 1024

export type TranscriptFileHandle = FileHandle | WslTranscriptFsProcessHandle

// One request object drives both the gate's dedupe/route key and the child
// call, so the two can never disagree on the operation or path.
function runReusableFsOperation<T>(
  request: WslTranscriptFsReusableProcessCall,
  priority: WslTranscriptFsTaskPriority,
  signal: AbortSignal | undefined,
  localTask: () => Promise<T>
): Promise<T> {
  return isWslUncPath(request.path)
    ? runWslTranscriptFsTask(
        { operation: request.operation, path: request.path, priority, signal },
        (taskSignal) =>
          runWslTranscriptFsProcess<T>(
            request,
            taskSignal,
            wslTranscriptFsLaneKey(request.path, priority)
          )
      )
    : localTask()
}

export function wslGatedAccess(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<boolean> {
  return runReusableFsOperation({ operation: 'access', path }, priority, signal, async () => {
    await access(path)
    return true
  })
}

export function wslGatedStat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runReusableFsOperation({ operation: 'stat', path }, priority, signal, () => stat(path))
}

export function wslGatedLstat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Stats> {
  return runReusableFsOperation({ operation: 'lstat', path }, priority, signal, () => lstat(path))
}

export function wslGatedReaddir(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Dirent[]> {
  return runReusableFsOperation({ operation: 'readdir', path }, priority, signal, () =>
    readdir(path, { withFileTypes: true })
  )
}

export function wslGatedReadFile(
  path: string,
  encoding: BufferEncoding,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<string> {
  return runReusableFsOperation({ operation: 'readfile', path, encoding }, priority, signal, () =>
    readFile(path, encoding)
  )
}

// dedupe:false — two joiners would share one FileHandle and both close it.
export function wslGatedOpen(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<TranscriptFileHandle> {
  if (!isWslUncPath(path)) {
    return open(path, 'r')
  }
  return runWslTranscriptFsTask<TranscriptFileHandle>(
    {
      operation: 'open',
      path,
      priority,
      signal,
      dedupe: false,
      onAbandonedResult: (handle) => void closeTranscriptHandle(handle, path)
    },
    (taskSignal) =>
      openWslTranscriptFsProcess(path, taskSignal, wslTranscriptFsLaneKey(path, priority))
  )
}

/**
 * `path` is only the gate's route key and UNC guard — the handle carries no
 * path and is never re-opened. dedupe:false because `read` fills the CALLER's
 * buffer: a joiner would receive the first caller's buffer while its own
 * (often `Buffer.allocUnsafe`) stays uninitialized.
 */
export function wslGatedRead(
  handle: TranscriptFileHandle,
  path: string,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<{ bytesRead: number; buffer: Buffer }> {
  // Handle kind decides before path spelling: a process-owned handle must never
  // hit the FileHandle branch even if a caller re-derives the path off-UNC.
  if (!isWslUncPath(path) && !isWslTranscriptFsProcessHandle(handle)) {
    return (handle as FileHandle).read(buffer, offset, length, position)
  }
  return runWslTranscriptFsTask(
    { operation: 'read', path, priority, signal, dedupe: false },
    async (taskSignal) => {
      if (!isWslTranscriptFsProcessHandle(handle)) {
        // The vitest fallback: a FileHandle read fills the caller's buffer itself.
        return (handle as FileHandle).read(buffer, offset, length, position)
      }
      const body = await readWslTranscriptFsProcess(handle, position, length, taskSignal)
      buffer.set(body, offset)
      return { bytesRead: body.byteLength, buffer }
    }
  )
}

/** Never gated; process-owned handles retire on the client's bounded deadline. */
export function closeTranscriptHandle(handle: TranscriptFileHandle, path: string): Promise<void> {
  if (isWslTranscriptFsProcessHandle(handle)) {
    void closeWslTranscriptFsProcess(handle).catch(() => {})
    return Promise.resolve()
  }
  if (!isWslUncPath(path)) {
    return handle.close()
  }
  // Only the vitest fallback pairs a FileHandle with a UNC path; mirror the
  // process-handle contract there: fire-and-forget, close failures swallowed.
  void handle.close().catch(() => {})
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
