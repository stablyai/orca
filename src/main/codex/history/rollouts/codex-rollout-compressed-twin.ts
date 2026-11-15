import type { BigIntStats, Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
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
function plainWins(plain: BigIntStats, compressed: BigIntStats): boolean {
  return compressed.size === 0n || plain.mtimeNs > compressed.mtimeNs
}

function isFile(stats: BigIntStats | undefined): stats is BigIntStats {
  return stats?.isFile() ?? false
}

/**
 * Whether the rollout at `from` stays out of the store at `to` so it holds one form only: the
 * `.zst` unless its `.jsonl` twin is newer. A store that already holds either form keeps it alone,
 * except for a newer `.jsonl`, whose appended lines the `.zst` lacks.
 */
export async function isRolloutTwinKeptFromStore(from: string, to: string): Promise<boolean> {
  if (!parseCodexRolloutThreadId(from)) {
    return false
  }
  const compressed = from.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
  const [self, storeTwin, sourceTwin] = await Promise.all([
    lstatIfPresent(from),
    lstatIfPresent(rolloutTwinPath(to)),
    lstatIfPresent(rolloutTwinPath(from))
  ])
  if (!isFile(self)) {
    return false
  }
  const selfWins = (twin: BigIntStats): boolean =>
    compressed ? !plainWins(twin, self) : plainWins(self, twin)
  if (isFile(storeTwin)) {
    return compressed || !selfWins(storeTwin)
  }
  return isFile(sourceTwin) && !selfWins(sourceTwin)
}

/** Whether a folder holds both forms of a rollout, so it must merge file by file. */
export async function holdsRolloutTwins(folder: string): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
  const names = new Set(entries.map((entry) => entry.name))
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await holdsRolloutTwins(join(folder, entry.name))) {
        return true
      }
    } else if (
      entry.name.endsWith(COMPRESSED_ROLLOUT_SUFFIX) &&
      names.has(rolloutTwinPath(entry.name)) &&
      parseCodexRolloutThreadId(entry.name)
    ) {
      return true
    }
  }
  return false
}
