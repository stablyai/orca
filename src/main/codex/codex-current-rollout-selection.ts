import { parseWslUncPath } from '../../shared/wsl-paths'
import { codexRolloutFileNameOf, compareCodexRolloutRecency } from './codex-rollout-file-name'
import { resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import { readCodexThreadRolloutFileNames } from './codex-state-db'

/** A scan's memo of each SQLite home's thread selections, so each DB is read once. */
export type CodexSelectionCache = Map<string, Map<string, string> | null>

/**
 * The file name Codex's state DB selects for this rollout's thread, or null
 * when no DB answers. For a paginated thread that row, not the newest file, is
 * what `codex resume` opens.
 */
export function readCodexSelectedRolloutFileName(
  rolloutPath: string,
  cache?: CodexSelectionCache
): string | null {
  const name = codexRolloutFileNameOf(rolloutPath)
  const home = /^(.*)[\\/](?:archived_)?sessions[\\/]/.exec(rolloutPath)?.[1]
  // Why: SQLite cannot lock over \\wsl.localhost; a distro falls back to the filename rule.
  if (!name || !home || parseWslUncPath(rolloutPath)) {
    return null
  }
  const sqliteHome = resolveEffectiveCodexSqliteHome(home)
  if (!cache) {
    return readCodexThreadRolloutFileNames(sqliteHome, name.threadId)?.get(name.threadId) ?? null
  }
  let selection = cache.get(sqliteHome)
  if (selection === undefined) {
    selection = readCodexThreadRolloutFileNames(sqliteHome)
    cache.set(sqliteHome, selection)
  }
  return selection?.get(name.threadId) ?? null
}

/** The segment of one conversation that Codex would resume, from its candidate files. */
export function selectCurrentCodexRollout(paths: readonly string[]): string | null {
  const fileNameOf = (path: string): string => path.split(/[\\/]/).at(-1) ?? ''
  const selected = paths[0] ? readCodexSelectedRolloutFileName(paths[0]) : null
  const bySelection = selected ? paths.find((path) => fileNameOf(path) === selected) : undefined
  if (bySelection) {
    return bySelection
  }
  let newest: string | null = null
  for (const path of paths) {
    const name = codexRolloutFileNameOf(path)
    const newestName = newest ? codexRolloutFileNameOf(newest) : null
    if (!newest || (name && (!newestName || compareCodexRolloutRecency(name, newestName) > 0))) {
      newest = path
    }
  }
  return newest
}
