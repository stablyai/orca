import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import {
  clearDarwinLockFlag,
  readingSource,
  removeStagedCopy,
  stageRolloutCopy
} from './codex-rollout-staged-copy'

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
  /** Abandons the copy (`stopped`) once this turns true. */
  shouldStop?: () => boolean
}

function sameSource(before: BigIntStats, after: BigIntStats): boolean {
  return before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs
}

function nsToSeconds(ns: bigint): number {
  return Number(ns) / 1e9
}

async function publish(
  temporaryPath: string,
  targetPath: string,
  cloned: boolean
): Promise<'copied' | 'existing'> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // A same-volume hard link publishes atomically without replacing a concurrent target.
      await link(temporaryPath, targetPath)
      return 'copied'
    } catch (error) {
      const code = errnoCodeOrUnknown(error)
      if (code === 'EEXIST') {
        return 'existing'
      }
      // A macOS clone keeps a Finder-locked source's flag, which refuses the link.
      if (
        cloned &&
        attempt === 0 &&
        code === 'EPERM' &&
        (await clearDarwinLockFlag(temporaryPath))
      ) {
        continue
      }
      // Node has no portable atomic rename-if-absent; refuse filesystems without hard links.
      throw isHardLinkUnsupportedError(error)
        ? new AtomicNoReplaceUnsupportedError(targetPath, error)
        : error
    }
  }
}

/**
 * Copies a rollout to `targetPath` through a staged non-rollout name, so readers never see a
 * partial file, and never replaces one already there (`existing`). Failures reading the source
 * throw `RolloutSourceReadError`.
 */
export async function copyCodexRolloutWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  options: CopyOptions
): Promise<CodexRolloutCopyOutcome> {
  const temporaryPath = join(dirname(targetPath), `.orca-${options.purpose}-${randomUUID()}.tmp`)
  const readSource = (): Promise<BigIntStats> =>
    readingSource(sourcePath, () => stat(sourcePath, { bigint: true }))
  const source = await readSource()
  try {
    const staged = await stageRolloutCopy(
      source,
      sourcePath,
      temporaryPath,
      options.shouldStop ?? (() => false)
    )
    if (staged === 'stopped') {
      return 'stopped'
    }
    if (staged === 'copied') {
      // Compressed-twin rules and recency read the rollout's mtime.
      await utimes(temporaryPath, nsToSeconds(source.atimeNs), nsToSeconds(source.mtimeNs))
    }
    if (options.requireStableSource && !sameSource(source, await readSource())) {
      return 'source-changed'
    }
    return await publish(temporaryPath, targetPath, staged === 'cloned')
  } finally {
    try {
      await removeStagedCopy(temporaryPath)
    } catch (error) {
      // Codex ignores .tmp files; cleanup failure must not invalidate a successful publication.
      console.warn('[codex-rollout-copy] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}
