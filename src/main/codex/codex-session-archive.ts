import type { Stats } from 'node:fs'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Codex archives a thread by renaming every rollout of that thread out of
// `<CODEX_HOME>/sessions/YYYY/MM/DD/` into this flat sibling directory. A cold
// archived rollout is later replaced by a `<name>.zst` sibling by Codex's
// background compression worker, so both spellings mean "archived".
const CODEX_ARCHIVED_SESSIONS_DIR_NAME = 'archived_sessions'
const CODEX_COMPRESSED_ROLLOUT_SUFFIX = '.zst'

/** Mirrors `dirname(systemSessionsRoot)` as the real Codex home, like the heal does. */
export function resolveCodexArchivedSessionsRoot(systemSessionsRoot: string): string {
  return join(dirname(systemSessionsRoot), CODEX_ARCHIVED_SESSIONS_DIR_NAME)
}

/**
 * Stats the archived copy of a rollout, or null when the user has not archived it.
 *
 * Throws on anything but ENOENT: an unreadable archive must never read back as
 * "not archived", because the caller would then resurrect the thread.
 */
export async function readArchivedCodexRolloutStat(
  systemSessionsRoot: string,
  rolloutFileName: string
): Promise<Stats | null> {
  const archivedSessionsRoot = resolveCodexArchivedSessionsRoot(systemSessionsRoot)
  for (const fileName of [
    rolloutFileName,
    `${rolloutFileName}${CODEX_COMPRESSED_ROLLOUT_SUFFIX}`
  ]) {
    try {
      return await lstat(join(archivedSessionsRoot, fileName))
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }
    }
  }
  return null
}

/**
 * Reads every archived rollout name once, compressed siblings normalized back to
 * their plain `.jsonl` spelling, so a whole audit ledger can be classified
 * against one directory read. Async so a large archive cannot stall the main thread.
 */
export async function readArchivedCodexRolloutNames(
  systemSessionsRoot: string
): Promise<Set<string>> {
  const archivedSessionsRoot = resolveCodexArchivedSessionsRoot(systemSessionsRoot)
  let entries: string[]
  try {
    entries = await readdir(archivedSessionsRoot)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
    return new Set()
  }
  return new Set(
    entries.map((entry) =>
      entry.endsWith(CODEX_COMPRESSED_ROLLOUT_SUFFIX)
        ? entry.slice(0, -CODEX_COMPRESSED_ROLLOUT_SUFFIX.length)
        : entry
    )
  )
}

/**
 * Removes an active rollout name that is provably a second hardlink to the
 * already-archived inode — residue from a backfill pass that republished the
 * managed copy before the archive was consulted. Any other file is left alone,
 * so no rollout contents can be lost.
 */
export async function removeResurrectedActiveCodexRollout(
  systemSessionFilePath: string,
  archivedStat: Stats
): Promise<void> {
  let activeStat: Stats
  try {
    activeStat = await lstat(systemSessionFilePath)
  } catch (error) {
    if (isNotFoundError(error)) {
      return
    }
    throw error
  }
  if (!isSameHardLink(activeStat, archivedStat)) {
    return
  }
  try {
    await unlink(systemSessionFilePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }
}

// Why: Windows reports ino 0 on filesystems without a stable file index, where
// two unrelated zeros would otherwise read as one shared inode.
function isSameHardLink(left: Stats, right: Stats): boolean {
  return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
