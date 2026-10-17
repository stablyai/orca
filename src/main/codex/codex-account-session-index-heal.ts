import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession
} from './codex-app-server-session'
import {
  buildNativeHealInvocation,
  readCodexThreadsForIndexHeal,
  type CodexSessionIndexHealOptions,
  type CodexThreadReadPassOutcome
} from './codex-session-index-heal'
import { readIndexedCodexThreadIds } from './codex-state-db'

// Why: Codex indexes a home's rollouts only once, when it first creates the
// state DB, and the /resume picker's "All" view lists only indexed threads.
// History bridged in afterwards needs `thread/read`, Codex's lazy-indexing
// path, to become visible there (#20669).

export type CodexAccountSessionIndexHealSummary = {
  outcome: CodexThreadReadPassOutcome | 'up-to-date' | 'no-index'
  healedThreads: number
  missingThreads: number
  failedThreads: number
}

export type CodexAccountSessionIndexHealOptions = CodexSessionIndexHealOptions & {
  readIndexedThreadIds?: (codexHomePath: string) => Set<string> | null
}

// Why: app-server finishes state DB startup before it answers `initialize`,
// which takes ~100ms on an empty home.
const STATE_DB_CREATE_TIMEOUT_MS = 15_000

// Why: a just-linked rollout Codex refuses or cannot find fails the same way on
// every read; skip it until Orca restarts instead of respawning app-server each launch.
const failedThreadIdsByHome = new Map<string, Set<string>>()

/**
 * Starts Codex once so the home's state DB exists and its startup backfill is
 * complete: app-server answers `initialize` only after both. Run on an empty
 * home before any history is bridged in. False when Codex could not start.
 */
export async function createCodexAccountStateDb(
  codexHomePath: string,
  options: Pick<CodexSessionIndexHealOptions, 'buildInvocation' | 'runSession'> & {
    timeoutMs?: number
  } = {}
): Promise<boolean> {
  const buildInvocation = options.buildInvocation ?? buildNativeHealInvocation
  const runSession = options.runSession ?? runCodexAppServerSession
  const timeoutMs = options.timeoutMs ?? STATE_DB_CREATE_TIMEOUT_MS
  try {
    await runSession(buildInvocation(codexHomePath, timeoutMs), async () => {})
    return true
  } catch (error) {
    // Why: a Codex without app-server predates the state DB, so linking cannot stall it.
    if (isCodexAppServerUnsupportedError(error)) {
      return true
    }
    console.warn('[codex-account-session-index-heal] Failed to create Codex state DB:', error)
    return false
  }
}

/**
 * Indexes the bridged threads Codex has not indexed yet, newest rollout first.
 * Diffing against the state DB on every pass makes an interrupted heal resume
 * on the next launch.
 */
export async function healCodexAccountSessionIndex(
  codexHomePath: string,
  bridgedThreads: ReadonlyMap<string, string>,
  options: CodexAccountSessionIndexHealOptions = {}
): Promise<CodexAccountSessionIndexHealSummary> {
  if (bridgedThreads.size === 0) {
    return upToDateSummary()
  }
  // Why: with no DB in the home, Codex keeps none (older CLI) or uses a
  // `sqlite_home` shared by every Orca home, which already indexes these threads.
  const indexed = (options.readIndexedThreadIds ?? readIndexedCodexThreadIds)(codexHomePath)
  if (!indexed) {
    return { ...upToDateSummary(), outcome: 'no-index' }
  }
  const unindexed = new Map([...bridgedThreads].filter(([threadId]) => !indexed.has(threadId)))
  return healPendingCodexAccountThreads(codexHomePath, unindexed, options)
}

/**
 * Indexes `pendingThreads` (thread id -> rollout timestamp), newest rollout
 * first, skipping threads that already failed in this home since Orca started.
 */
export async function healPendingCodexAccountThreads(
  codexHomePath: string,
  pendingThreads: ReadonlyMap<string, string>,
  options: CodexSessionIndexHealOptions = {}
): Promise<CodexAccountSessionIndexHealSummary> {
  const summary = upToDateSummary()
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const failed = failedThreadIdsByHome.get(homeKey) ?? new Set<string>()
  failedThreadIdsByHome.set(homeKey, failed)
  // Why: a large history takes minutes to index, and /resume hides unindexed
  // threads once a directory has any indexed one, so recent work goes first.
  const pending = [...pendingThreads]
    .filter(([threadId]) => !failed.has(threadId))
    .sort(([, left], [, right]) => (left < right ? 1 : left > right ? -1 : 0))
    .map(([threadId]) => ({ threadId }))
  if (pending.length === 0) {
    return summary
  }
  summary.outcome = await readCodexThreadsForIndexHeal(
    codexHomePath,
    pending,
    ({ threadId }, outcome) => {
      if (outcome === 'healed') {
        summary.healedThreads += 1
        return
      }
      failed.add(threadId)
      if (outcome === 'missing') {
        summary.missingThreads += 1
      } else {
        summary.failedThreads += 1
      }
    },
    options
  )
  return summary
}

function upToDateSummary(): CodexAccountSessionIndexHealSummary {
  return { outcome: 'up-to-date', healedThreads: 0, missingThreads: 0, failedThreads: 0 }
}

export const _internals = {
  resetFailedThreads: (): void => {
    failedThreadIdsByHome.clear()
  }
}
