import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { splitOpenCodeSqliteCandidate } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import { underDegradedRoot, type SessionSearchDegradedRoot } from './session-search-root-health'
import type { SessionSearchStore } from './session-search-store'

export type SessionSearchRetirement = {
  /** Paths proven gone and dropped from the index. */
  retired: string[]
  /** Paths that could not be statted; their rows stay, and they stay watched. */
  unverifiable: string[]
  /** Paths the per-cycle cap left for next time. */
  unchecked: string[]
}

// Why only ENOENT retires a source: docs/reference/ssh-execution-boundary.md —
// loss of contact is never evidence of absence. An EACCES, an EIO or a stalled
// WSL distro leaves the rows exactly where they are, because the alternative is
// erasing a user's searchable history the first time a mount hiccups.
const PROVEN_GONE = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Retires index rows for sources that are provably gone. Callers pass the paths
 * the index holds but did not discover; everything else is either still there
 * or was never in the discovery window in the first place.
 *
 * The degraded-root fence lives here, not at the call sites, because both the
 * sweep and the cycle retire and either one alone would delete a user's history
 * the first time an SSH mount or an external drive is not there: every path
 * under it answers ENOENT at once. A file under a root this pass could not
 * trust is `unverifiable`, whatever the filesystem says
 * (docs/reference/ssh-execution-boundary.md).
 */
export async function retireDeletedSessionSearchSources(
  store: SessionSearchStore,
  paths: readonly string[],
  options: {
    signal?: AbortSignal
    limit?: number
    degradedRoots?: readonly SessionSearchDegradedRoot[]
  } = {}
): Promise<SessionSearchRetirement> {
  const { signal } = options
  const degradedRoots = options.degradedRoots ?? []
  const retirement: SessionSearchRetirement = { retired: [], unverifiable: [], unchecked: [] }
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  for (const [index, path] of paths.entries()) {
    // Why capped: the sweep hands over every path it discovered, and one stat
    // per transcript on a 3,600-session machine is not a cycle's worth of work.
    // What is left keeps being watched, so the check finishes over a few cycles.
    if (signal?.aborted || index >= limit) {
      retirement.unchecked.push(...paths.slice(index))
      break
    }
    if (underDegradedRoot(path, degradedRoots)) {
      retirement.unverifiable.push(path)
      continue
    }
    // A synthetic OpenCode row names the database it came from, never a file of
    // its own; statting the candidate path would report every one of them gone.
    const statPath = splitOpenCodeSqliteCandidate(path)?.dbPath ?? path
    try {
      await wslGatedStat(statPath, 'scan', signal)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null
      if (code !== null && PROVEN_GONE.has(code)) {
        store.removeFile(path)
        retirement.retired.push(path)
        continue
      }
      retirement.unverifiable.push(path)
    }
  }
  return retirement
}
