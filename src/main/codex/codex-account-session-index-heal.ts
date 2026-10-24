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

// thread/read lazily indexes bridged history so /resume's indexed-only "All" view can show it.
export type CodexAccountSessionIndexHealSummary = {
  outcome: CodexThreadReadPassOutcome | 'up-to-date' | 'no-index'
  healedThreads: number
  missingThreads: number
  failedThreads: number
}

export type CodexAccountSessionIndexHealOptions = CodexSessionIndexHealOptions & {
  readIndexedThreadIds?: (codexHomePath: string) => Set<string> | null
}

// app-server finishes state DB startup before answering initialize.
const STATE_DB_CREATE_TIMEOUT_MS = 15_000

// Cache failed reads until restart to avoid respawning app-server for the same refused/missing thread.
const failedThreadIdsByHome = new Map<string, Set<string>>()

/** Initialize before bridging history to avoid startup backfill; false if Codex could not start. */
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

/** Diff against the state DB each pass so interrupted indexing resumes on the next launch. */
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
  // No local DB means an older CLI or sqlite_home owns indexing elsewhere.
  const indexed = (options.readIndexedThreadIds ?? readIndexedCodexThreadIds)(codexHomePath)
  if (!indexed) {
    return { ...summary, outcome: 'no-index' }
  }
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const failed = failedThreadIdsByHome.get(homeKey) ?? new Set<string>()
  failedThreadIdsByHome.set(homeKey, failed)
  // /resume hides unindexed threads once any are indexed; prioritize recent work during long heals.
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
