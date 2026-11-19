import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { copyFile, link, open, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'

// Below this a cp spawn costs more than the copy it saves.
const MIN_DARWIN_CLONE_BYTES = 1024 * 1024
// From this size a copy that can't be interrupted could hold a waiting launch too long.
const MIN_INTERRUPTIBLE_COPY_BYTES = 8 * 1024 * 1024
const COPY_CHUNK_BYTES = 1024 * 1024
const STOP_POLL_MS = 50
const HARDLINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

export class AtomicNoReplaceUnsupportedError extends Error {
  constructor(targetPath: string, cause: unknown) {
    super(`Cannot publish a rollout copy without overwrite on this filesystem: ${targetPath}`, {
      cause
    })
    this.name = 'AtomicNoReplaceUnsupportedError'
  }
}

/** Whether a `link()` failed because the filesystem has no hard links. */
export function isHardLinkUnsupportedError(error: unknown): boolean {
  const code = errnoCodeOrUnknown(error)
  // Windows reports CreateHardLinkW's ERROR_INVALID_FUNCTION (FAT, exFAT) as EISDIR.
  return HARDLINK_UNSUPPORTED_CODES.has(code) || (process.platform === 'win32' && code === 'EISDIR')
}

export type CodexRolloutCopyOutcome = 'copied' | 'existing' | 'source-changed' | 'stopped'

type CopyOptions = {
  /** Names the staged file `.orca-<purpose>-<uuid>.tmp`. */
  purpose: 'backfill' | 'import'
  /** Discards the copy when the source changed while it was copied. */
  requireStableSource?: boolean
  /** Abandons a long copy (`stopped`) once this turns true. */
  shouldStop?: () => boolean
}

function sameSource(before: BigIntStats, after: BigIntStats): boolean {
  return before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs
}

function nsToSeconds(ns: bigint): number {
  return Number(ns) / 1e9
}

async function clearDarwinLockFlag(path: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program: '/usr/bin/chflags',
      args: ['nouchg', path],
      maxOutputBytes: 8192
    })
    return result.code === 0
  } catch {
    return false
  }
}

/** Removes a staged copy, clearing a Finder lock a macOS clone carried over from its source. */
export async function removeStagedCopy(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    // EPERM under Node; other runtimes report a locked file differently, so any failure retries once.
    if (process.platform !== 'darwin' || !(await clearDarwinLockFlag(path))) {
      throw error
    }
    await rm(path, { force: true })
  }
}

function abortWhen(shouldStop: () => boolean): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const check = (): void => {
    if (shouldStop()) {
      controller.abort()
    } else {
      timer = setTimeout(check, STOP_POLL_MS)
    }
  }
  timer = setTimeout(check, STOP_POLL_MS)
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

async function cloneOnDarwin(
  sourcePath: string,
  temporaryPath: string,
  shouldStop: () => boolean
): Promise<'cloned' | 'failed' | 'stopped'> {
  const stop = abortWhen(shouldStop)
  try {
    // Node's clone flag never clones on macOS; cp -c does, and falls back to copying itself.
    const result = await runProcess({
      program: '/bin/cp',
      args: ['-c', '-p', sourcePath, temporaryPath],
      timeoutMs: null,
      maxOutputBytes: 8192,
      signal: stop.signal
    })
    if (stop.signal.aborted) {
      return 'stopped'
    }
    // A clone keeps the source's Finder lock, which would refuse the link and the cleanup.
    if (result.code === 0 && (await clearDarwinLockFlag(temporaryPath))) {
      return 'cloned'
    }
  } catch {
    // Falls through to an ordinary copy.
  } finally {
    stop.dispose()
  }
  await removeStagedCopy(temporaryPath)
  return 'failed'
}

async function copyInChunks(
  sourcePath: string,
  temporaryPath: string,
  mode: number,
  shouldStop: () => boolean
): Promise<'copied' | 'stopped'> {
  const source = await open(sourcePath, 'r')
  try {
    const target = await open(temporaryPath, 'wx', mode)
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      while (!shouldStop()) {
        const { bytesRead } = await source.read(buffer, 0, COPY_CHUNK_BYTES, null)
        if (bytesRead === 0) {
          return 'copied'
        }
        let written = 0
        while (written < bytesRead) {
          written += (await target.write(buffer, written, bytesRead - written)).bytesWritten
        }
      }
      return 'stopped'
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}

async function copyLargeFile(
  source: BigIntStats,
  sourcePath: string,
  temporaryPath: string,
  shouldStop: () => boolean
): Promise<'copied' | 'stopped'> {
  try {
    // A reflink, or an immediate error where the filesystem has none.
    await copyFile(
      sourcePath,
      temporaryPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
    )
    return 'copied'
  } catch {
    await removeStagedCopy(temporaryPath)
  }
  return copyInChunks(sourcePath, temporaryPath, Number(source.mode & 0o777n), shouldStop)
}

async function stageCopy(
  source: BigIntStats,
  sourcePath: string,
  temporaryPath: string,
  shouldStop: () => boolean
): Promise<'copied' | 'stopped'> {
  if (process.platform === 'darwin' && source.size >= MIN_DARWIN_CLONE_BYTES) {
    const cloned = await cloneOnDarwin(sourcePath, temporaryPath, shouldStop)
    if (cloned !== 'failed') {
      return cloned === 'cloned' ? 'copied' : 'stopped'
    }
  }
  if (source.size >= MIN_INTERRUPTIBLE_COPY_BYTES) {
    return copyLargeFile(source, sourcePath, temporaryPath, shouldStop)
  }
  // Reflinks on Linux; on Windows CopyFileW block-clones on ReFS and Dev Drive.
  await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  return 'copied'
}

/**
 * Copies a rollout to `targetPath` through a staged non-rollout name, so readers never see a
 * partial file, and never replaces one already there (`existing`).
 */
export async function copyCodexRolloutWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  options: CopyOptions
): Promise<CodexRolloutCopyOutcome> {
  const temporaryPath = join(dirname(targetPath), `.orca-${options.purpose}-${randomUUID()}.tmp`)
  const source = await stat(sourcePath, { bigint: true })
  try {
    if (
      (await stageCopy(source, sourcePath, temporaryPath, options.shouldStop ?? (() => false))) ===
      'stopped'
    ) {
      return 'stopped'
    }
    // Compressed-twin rules and recency read the rollout's mtime.
    await utimes(temporaryPath, nsToSeconds(source.atimeNs), nsToSeconds(source.mtimeNs))
    if (
      options.requireStableSource &&
      !sameSource(source, await stat(sourcePath, { bigint: true }))
    ) {
      return 'source-changed'
    }
    try {
      // A same-volume hard link publishes atomically without replacing a concurrent target.
      await link(temporaryPath, targetPath)
      return 'copied'
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'EEXIST') {
        return 'existing'
      }
      // Node has no portable atomic rename-if-absent; refuse filesystems without hard links.
      throw isHardLinkUnsupportedError(error)
        ? new AtomicNoReplaceUnsupportedError(targetPath, error)
        : error
    }
  } finally {
    try {
      await removeStagedCopy(temporaryPath)
    } catch (error) {
      // Codex ignores .tmp files; cleanup failure must not invalidate a successful publication.
      console.warn('[codex-rollout-copy] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}
