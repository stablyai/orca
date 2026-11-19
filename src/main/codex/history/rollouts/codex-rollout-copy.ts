import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { copyFile, link, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'

// Below this a cp spawn costs more than the copy it saves.
const MIN_DARWIN_CLONE_BYTES = 1024 * 1024
const HARDLINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

export class AtomicNoReplaceUnsupportedError extends Error {
  constructor(targetPath: string, cause: unknown) {
    super(`Cannot publish a rollout copy without overwrite on this filesystem: ${targetPath}`, {
      cause
    })
    this.name = 'AtomicNoReplaceUnsupportedError'
  }
}

export type CodexRolloutCopyOutcome = 'copied' | 'existing' | 'source-changed'

type CopyOptions = {
  /** Names the staged file `.orca-<purpose>-<uuid>.tmp`. */
  purpose: 'backfill' | 'import'
  /** Discards the copy when the source changed while it was copied. */
  requireStableSource?: boolean
}

function sameSource(before: BigIntStats, after: BigIntStats): boolean {
  return before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs
}

function nsToSeconds(ns: bigint): number {
  return Number(ns) / 1e9
}

async function cloneOnDarwin(sourcePath: string, temporaryPath: string): Promise<boolean> {
  try {
    // Node's clone flag never clones on macOS; cp -c does, and falls back to copying itself.
    const result = await runProcess({
      program: '/bin/cp',
      args: ['-c', '-p', sourcePath, temporaryPath],
      timeoutMs: null,
      maxOutputBytes: 8192
    })
    if (result.code === 0) {
      return true
    }
  } catch {
    // Falls through to an ordinary copy.
  }
  await rm(temporaryPath, { force: true })
  return false
}

async function stageCopy(
  source: BigIntStats,
  sourcePath: string,
  temporaryPath: string
): Promise<void> {
  const cloned =
    process.platform === 'darwin' &&
    source.size >= MIN_DARWIN_CLONE_BYTES &&
    (await cloneOnDarwin(sourcePath, temporaryPath))
  if (!cloned) {
    // Reflinks on Linux; on Windows CopyFileW block-clones on ReFS and Dev Drive.
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  }
  // Compressed-twin rules and recency read the rollout's mtime.
  await utimes(temporaryPath, nsToSeconds(source.atimeNs), nsToSeconds(source.mtimeNs))
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
    await stageCopy(source, sourcePath, temporaryPath)
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
      const code = errnoCodeOrUnknown(error)
      if (code === 'EEXIST') {
        return 'existing'
      }
      // Node has no portable atomic rename-if-absent; refuse filesystems without hard links.
      throw HARDLINK_UNSUPPORTED_CODES.has(code)
        ? new AtomicNoReplaceUnsupportedError(targetPath, error)
        : error
    }
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch (error) {
      // Codex ignores .tmp files; cleanup failure must not invalidate a successful publication.
      console.warn('[codex-rollout-copy] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}
