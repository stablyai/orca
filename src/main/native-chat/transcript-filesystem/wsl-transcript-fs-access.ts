import {
  beginTranscriptWholeRead,
  noteTranscriptFsActivity,
  observeTranscriptStat
} from './transcript-fs-observation'
import type { Dirent, Stats } from 'node:fs'
import { access, lstat, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { runWslTranscriptFsTask, type WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import {
  closeWslTranscriptFsProcess,
  isWslTranscriptFsProcessHandle,
  openWslTranscriptFsProcess,
  readWslTranscriptFsProcess,
  runWslTranscriptFsProcess
} from './process/wsl-transcript-fs-process-dispatch'
import type { WslTranscriptFsProcessHandle } from './process/wsl-transcript-fs-process-slot'
import type { WslTranscriptFsReusableProcessCall } from './process/wsl-transcript-fs-process-protocol'
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
export type TranscriptFileStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino'> &
  Partial<Pick<Stats, 'birthtimeMs'>>

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
  return waitForPromiseWithSignal(pending, signal).finally(noteTranscriptFsActivity)
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
  return observeTranscriptStat(path, () =>
    runReusableFsOperation({ operation: 'stat', path }, priority, signal, () => stat(path))
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
  const done = beginTranscriptWholeRead(path)
  return runReusableFsOperation({ operation: 'readfile', path, encoding }, priority, signal, () =>
    readFile(path, { encoding, signal })
  ).finally(done)
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
    return waitForPromiseWithSignal(readSshTranscript(handle), signal).finally(
      noteTranscriptFsActivity
    )
  }
  // Process handle identity overrides path spelling; never route it into native FileHandle reads.
  if (!isWslUncPath(path) && !isWslTranscriptFsProcessHandle(handle)) {
    return waitForPromiseWithSignal(
      (handle as FileHandle).read(buffer, offset, length, position),
      signal
    ).finally(noteTranscriptFsActivity)
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
  ).finally(noteTranscriptFsActivity)
}

/** An aborted close wait must not replace the read's own outcome or fail stream teardown. */
export function closeTranscriptHandleWithSignal(
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

export {
  openTranscriptReadStream,
  type TranscriptReadStreamOptions
} from './transcript-read-stream'
