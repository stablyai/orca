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
 * Starts Codex once on an empty home so it creates and indexes its state DB
 * before any history is bridged in. False when Codex could not start.
 */
export async function createCodexAccountStateDb(
  codexHomePath: string,
  options: Pick<CodexSessionIndexHealOptions, 'buildInvocation' | 'runSession'> = {}
): Promise<boolean> {
  const buildInvocation = options.buildInvocation ?? buildNativeHealInvocation
  const runSession = options.runSession ?? runCodexAppServerSession
  try {
    await runSession(buildInvocation(codexHomePath, STATE_DB_CREATE_TIMEOUT_MS), async () => {})
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
  const summary: CodexAccountSessionIndexHealSummary = {
    outcome: 'up-to-date',
    healedThreads: 0,
    missingThreads: 0,
    failedThreads: 0
  }
  if (bridgedThreads.size === 0) {
    return summary
  }
  // Why: with no DB in the home, Codex keeps none (older CLI) or uses a
  // `sqlite_home` shared by every Orca home, which already indexes these threads.
  const indexed = (options.readIndexedThreadIds ?? readIndexedCodexThreadIds)(codexHomePath)
  if (!indexed) {
    return { ...summary, outcome: 'no-index' }
  }
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const failed = failedThreadIdsByHome.get(homeKey) ?? new Set<string>()
  failedThreadIdsByHome.set(homeKey, failed)
  // Why: a large history takes minutes to index, and /resume hides unindexed
  // threads once a directory has any indexed one, so recent work goes first.
  const pending = [...bridgedThreads]
    .filter(([threadId]) => !indexed.has(threadId) && !failed.has(threadId))
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

export const _internals = {
  resetFailedThreads: (): void => {
    failedThreadIdsByHome.clear()
  }
}
