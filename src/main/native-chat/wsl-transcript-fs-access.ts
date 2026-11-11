import { createReadStream, type Dirent, type Stats } from 'node:fs'
import {
  access,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  type FileHandle
} from 'node:fs/promises'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
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
import type {
  WslTranscriptFileSnapshot,
  WslTranscriptFsReusableProcessCall
} from './wsl-transcript-fs-process-protocol'
import { wslTranscriptFsLaneKey } from './wsl-transcript-fs-route'
import { admitWslTranscriptPath } from './wsl-transcript-running-admission'
import {
  readSshTranscript,
  statSshTranscript,
  type SshTranscriptHandle
} from './ssh-transcript-fs-access'
import { parseSshTranscriptPath } from './ssh-transcript-path'

/** Never nest a gated call inside another — that deadlocks the scan slot. */

// Deadline each chunk so healthy large files do not fail a whole-file timeout.
export const WSL_TRANSCRIPT_READ_CHUNK_BYTES = 1024 * 1024

export type TranscriptFileHandle = FileHandle | WslTranscriptFsProcessHandle | SshTranscriptHandle
export type TranscriptFileStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino'>

function isSshTranscriptHandle(handle: TranscriptFileHandle): handle is SshTranscriptHandle {
  return 'sshTranscript' in handle
}

// One request defines both route/dedup identity and child operation, preventing mismatches.
function runReusableFsOperation<T>(
  request: WslTranscriptFsReusableProcessCall,
  priority: WslTranscriptFsTaskPriority,
  signal: AbortSignal | undefined,
  localTask: () => Promise<T>
): Promise<T> {
  throwIfSignalAborted(signal)
  const pending = isWslUncPath(request.path)
    ? admitWslTranscriptPath(request.path).then(() =>
        runWslTranscriptFsTask(
          { operation: request.operation, path: request.path, priority, signal },
          async (taskSignal) => {
            // Queued work runs later: ask again right before the touch.
            await waitForPromiseWithSignal(admitWslTranscriptPath(request.path), taskSignal)
            return runWslTranscriptFsProcess<T>(
              request,
              taskSignal,
              wslTranscriptFsLaneKey(request.path, priority)
            )
          }
        )
      )
    : localTask()
  return waitForPromiseWithSignal(pending, signal)
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

export function wslGatedRealpath(path: string): Promise<string> {
  return runReusableFsOperation({ operation: 'realpath', path }, 'scan', undefined, () =>
    realpath(path)
  )
}

export function transcriptFileSnapshot(path: string): Promise<WslTranscriptFileSnapshot> {
  return runReusableFsOperation({ operation: 'snapshot', path }, 'scan', undefined, () =>
    stat(path, { bigint: true })
  )
}

export function transcriptFileStat(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<TranscriptFileStats> {
  const ssh = parseSshTranscriptPath(path)
  return ssh
    ? waitForPromiseWithSignal(statSshTranscript(ssh), signal)
    : wslGatedStat(path, priority, signal)
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

// Do not coalesce opens: joiners would share one handle and both close it.
export function openTranscriptFile(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<TranscriptFileHandle> {
  const ssh = parseSshTranscriptPath(path)
  if (ssh) {
    return Promise.resolve({ sshTranscript: ssh })
  }
  if (!isWslUncPath(path)) {
    throwIfSignalAborted(signal)
    const pending = open(path, 'r')
    return waitForPromiseWithSignal(pending, signal).catch((error: unknown) => {
      void pending
        .then(
          (handle) => handle.close(),
          () => undefined
        )
        .catch(() => undefined)
      throw error
    })
  }
  return openAdmittedWslTranscriptFile(path, priority, signal)
}

async function openAdmittedWslTranscriptFile(
  path: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<TranscriptFileHandle> {
  await waitForPromiseWithSignal(admitWslTranscriptPath(path), signal)
  return runWslTranscriptFsTask<TranscriptFileHandle>(
    {
      operation: 'open',
      path,
      priority,
      signal,
      dedupe: false,
      onAbandonedResult: (handle) => void closeTranscriptHandle(handle, path)
    },
    async (taskSignal) => {
      await waitForPromiseWithSignal(admitWslTranscriptPath(path), taskSignal)
      return openWslTranscriptFsProcess(path, taskSignal, wslTranscriptFsLaneKey(path, priority))
    }
  )
}

/** path selects route/UNC policy without reopening the handle. Never coalesce caller-buffer reads:
 * a joiner’s allocUnsafe buffer would remain uninitialized while receiving another caller’s result. */
export function readTranscriptFile(
  handle: TranscriptFileHandle,
  path: string,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<{ bytesRead: number; buffer: Buffer }> {
  if (isSshTranscriptHandle(handle)) {
    return waitForPromiseWithSignal(readSshTranscript(handle), signal)
  }
  // Process handle identity overrides path spelling; never route it into native FileHandle reads.
  if (!isWslUncPath(path) && !isWslTranscriptFsProcessHandle(handle)) {
    return waitForPromiseWithSignal(
      (handle as FileHandle).read(buffer, offset, length, position),
      signal
    )
  }
  return runWslTranscriptFsTask(
    { operation: 'read', path, priority, signal, dedupe: false },
    async (taskSignal) => {
      // An open 9P handle still reconnects (and boots) a distro that stopped since the open.
      await waitForPromiseWithSignal(admitWslTranscriptPath(path), taskSignal)
      if (!isWslTranscriptFsProcessHandle(handle)) {
        return (handle as FileHandle).read(buffer, offset, length, position)
      }
      const body = await readWslTranscriptFsProcess(handle, position, length, taskSignal)
      buffer.set(body, offset)
      return { bytesRead: body.byteLength, buffer }
    }
  )
}

/** An aborted close wait must not replace the read's own outcome or fail stream teardown. */
function closeTranscriptHandleWithSignal(
  handle: TranscriptFileHandle,
  path: string,
  signal?: AbortSignal
): Promise<void> {
  return waitForPromiseWithSignal(closeTranscriptHandle(handle, path), signal).catch(
    (error: unknown) => (signal?.aborted ? undefined : Promise.reject(error))
  )
}

/** Never gated; process-owned handles retire on the client's bounded deadline. */
export function closeTranscriptHandle(handle: TranscriptFileHandle, path: string): Promise<void> {
  if (isSshTranscriptHandle(handle)) {
    return Promise.resolve()
  }
  if (isWslTranscriptFsProcessHandle(handle)) {
    void closeWslTranscriptFsProcess(handle).catch(() => {})
    return Promise.resolve()
  }
  if (!isWslUncPath(path)) {
    return handle.close()
  }
  // Test-only UNC FileHandles mirror process close: fire-and-forget, swallowing failures.
  void handle.close().catch(() => {})
  return Promise.resolve()
}

/** Admit open/read separately so a stalled mount fails at the blocking syscall. */
export async function readTranscriptSlice(
  path: string,
  position: number,
  length: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Buffer> {
  const handle = await openTranscriptFile(path, priority, signal)
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await readTranscriptFile(
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
    await closeTranscriptHandleWithSignal(handle, path, signal)
  }
}

export type TranscriptReadStreamOptions = {
  start?: number
  end?: number
  /** Without encoding, decode Buffer chunks incrementally; boundaries may split multibyte codepoints. */
  encoding?: BufferEncoding
}

async function* gatedChunks(
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): AsyncGenerator<Buffer | string> {
  const handle = await openTranscriptFile(path, priority, signal)
  // Decode across chunk boundaries to avoid replacement characters on split codepoints.
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
      const { bytesRead } = await readTranscriptFile(
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
    const trailing = decoder?.end()
    if (trailing) {
      yield trailing
    }
  } finally {
    // Readable.destroy calls generator return, closing handles even after aborted head reads.
    await closeTranscriptHandleWithSignal(handle, path, signal)
  }
}

/** Deadline each UNC chunk separately; gate refusal reaches consumers as a stream error. */
export function openTranscriptReadStream(
  path: string,
  options: TranscriptReadStreamOptions,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Readable {
  if (!isWslUncPath(path) && !parseSshTranscriptPath(path)) {
    return createReadStream(path, { ...options, signal })
  }
  return Readable.from(gatedChunks(path, options, priority, signal))
}
