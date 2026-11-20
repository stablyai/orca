import type { BigIntStats, Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { parseCodexRolloutThreadId } from './codex-rollout-thread-id'

export const COMPRESSED_ROLLOUT_SUFFIX = '.zst'

/** The rollout's other form: `X.jsonl` for `X.jsonl.zst` and the reverse. */
export function rolloutTwinPath(path: string): string {
  return path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? path.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)
    : `${path}${COMPRESSED_ROLLOUT_SUFFIX}`
}

// Codex compresses a cold rollout keeping its mtime and appends to the `.jsonl` when both exist,
// so a `.jsonl` no newer than a non-empty `.zst` holds nothing the `.zst` lacks.
export function plainWins(plain: BigIntStats, compressed: BigIntStats): boolean {
  return compressed.size === 0n || plain.mtimeNs > compressed.mtimeNs
}

function isFile(stats: BigIntStats | undefined): stats is BigIntStats {
  return stats?.isFile() ?? false
}

/** Sorts `.zst` names first, so a folder's compressed form reaches the store before its twin. */
export function compressedRolloutsFirst(left: string, right: string): number {
  return (
    Number(right.endsWith(COMPRESSED_ROLLOUT_SUFFIX)) -
    Number(left.endsWith(COMPRESSED_ROLLOUT_SUFFIX))
  )
}

/**
 * Whether the rollout at `from` stays out of the store at `to` because the store already holds
 * its other form, so the store keeps one form: a `.jsonl` joins only when newer than the store's
 * `.zst` (its appended lines are missing there). Deciding against the store, never a sibling still
 * waiting to move, means a form is set aside only once its twin is safely in the store.
 */
export async function isRolloutTwinKeptFromStore(from: string, to: string): Promise<boolean> {
  if (!parseCodexRolloutThreadId(from)) {
    return false
  }
  const [self, storeTwin] = await Promise.all([
    lstatIfPresent(from),
    lstatIfPresent(rolloutTwinPath(to))
  ])
  if (!isFile(self) || !isFile(storeTwin)) {
    return false
  }
  return from.endsWith(COMPRESSED_ROLLOUT_SUFFIX) || !plainWins(self, storeTwin)
}

/** Plain-form paths of the rollouts under `folder` present in both forms, at most `limit`. */
export async function listRolloutTwinPairs(
  folder: string,
  limit = Infinity,
  /** Ends the walk early, with what it found so far. */
  shouldStop: () => boolean = () => false
): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
  const names = new Set(entries.map((entry) => entry.name))
  const pairs: string[] = []
  for (const entry of entries) {
    if (pairs.length >= limit || shouldStop()) {
      break
    }
    if (entry.isDirectory()) {
      pairs.push(
        ...(await listRolloutTwinPairs(join(folder, entry.name), limit - pairs.length, shouldStop))
      )
    } else if (
      entry.name.endsWith(COMPRESSED_ROLLOUT_SUFFIX) &&
      names.has(rolloutTwinPath(entry.name)) &&
      parseCodexRolloutThreadId(entry.name)
    ) {
      pairs.push(join(folder, rolloutTwinPath(entry.name)))
    }
  }
  return pairs
}

/** Whether a folder holds both forms of a rollout, so it must merge file by file. */
export async function holdsRolloutTwins(folder: string): Promise<boolean> {
  return (await listRolloutTwinPairs(folder, 1)).length > 0
}
