import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  readCodexThreadsForIndexHeal,
  type CodexSessionIndexHealOptions,
  type CodexThreadReadPassOutcome
} from './codex-session-index-heal'

// thread/read indexes history moved into a store so /resume's indexed-only "All" view can show it.
export type CodexAccountSessionIndexHealSummary = {
  outcome: CodexThreadReadPassOutcome | 'up-to-date'
  healedThreads: number
  missingThreads: number
  failedThreads: number
}

// Cache failed reads until restart to avoid respawning app-server for the same refused/missing thread.
const failedThreadIdsByHome = new Map<string, Set<string>>()

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
  // /resume hides unindexed threads once any are indexed; prioritize recent work during long heals.
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
