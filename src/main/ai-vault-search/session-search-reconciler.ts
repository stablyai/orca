import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import type { SessionSearchPendingFile } from './session-search-pending-files'
import type { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import {
  degradedSessionSearchRoots,
  type SessionSearchDegradedRoot
} from './session-search-root-health'
import {
  discoverSessionSearchCandidates,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'

// Why 512: one stat each, only for paths outside the recent window, and only
// until the set drains after a sweep. Large enough to converge in a handful of
// cycles on a 3,600-session machine, small enough not to be the cycle's cost.
export const DEFAULT_SESSION_SEARCH_RETIREMENT_CHECKS = 512

export type SessionSearchReconcileArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  status: SessionSearchIndexingStatus
  /** The sidebar's own recency rule: the newest N transcripts per agent root. */
  recentPerAgent: number
  allowance: SessionSearchCycleAllowance
  /** Rolled-over work and paths a caller invalidated, drained by the caller. */
  pending: readonly SessionSearchPendingFile[]
  /** Paths the previous cycle watched; one missing from this one may be gone. */
  previousRecent: ReadonlySet<string>
  /** Stats a cycle spends proving deletions; the rest stay watched. */
  retirementChecksPerCycle?: number
  signal?: AbortSignal
}

export type SessionSearchReconcileResult = {
  /** What the next cycle watches: this cycle's recent window plus what it could not settle. */
  recentPaths: Set<string>
  /** Work the allowance had no room for. */
  deferred: SessionSearchPendingFile[]
  degradedRoots: SessionSearchDegradedRoot[]
}

/**
 * One cycle. Re-stats the newest N per agent, folds in the store's stale set
 * and anything a caller invalidated, and reads whatever changed within the
 * cycle's allowance. Files outside the recent window are the full sweep's job,
 * which is the only promise a 20 s timer can actually keep on a machine with
 * thousands of transcripts and a 33 s cold discovery.
 */
export async function runSessionSearchReconcileCycle(
  args: SessionSearchReconcileArgs
): Promise<SessionSearchReconcileResult> {
  const { store, status, signal } = args
  status.beginCycle()
  return withCursorChatMetaScan(async () => {
    const swept = await discoverSessionSearchCandidates(args.roots, {
      limitPerAgent: args.recentPerAgent,
      signal
    })
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const recentPaths = new Set(swept.candidates.map((candidate) => candidate.file.path))
    const queued = await queuedCandidates(store, args.pending, recentPaths, signal)
    const stale = store.takeStale()
    const forced = new Set([
      ...stale.map((candidate) => candidate.file.path),
      ...args.pending.filter((entry) => entry.forced).map((entry) => entry.path)
    ])

    const pass = await runSessionSearchIndexPass(
      store,
      // A hole in the index is more urgent than a file that only grew, and
      // rolled-over work waited a cycle already, so both go before discovery.
      readOrder([stale, queued.candidates, swept.candidates], swept.candidates),
      {
        signal,
        forced,
        allowance: args.allowance,
        onIndexed: (_candidate, bytes) => status.indexed(bytes),
        onFailed: () => status.failed()
      }
    )

    const retirement = await retireDeletedSessionSearchSources(
      store,
      [...new Set([...args.previousRecent, ...queued.unstattable])].filter(
        (path) => !recentPaths.has(path)
      ),
      {
        signal,
        limit: args.retirementChecksPerCycle ?? DEFAULT_SESSION_SEARCH_RETIREMENT_CHECKS
      }
    )

    for (const refusal of cursorChatMetaRefusals()) {
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        message: refusal.message
      })
    }
    return {
      // An unreadable source is not a deleted one, and a path the cap did not
      // reach was never checked at all: both stay watched instead of being
      // retired or forgotten.
      recentPaths: new Set([...recentPaths, ...retirement.unverifiable, ...retirement.unchecked]),
      deferred: pass.deferred.map((candidate) => ({
        path: candidate.file.path,
        candidate,
        forced: forced.has(candidate.file.path)
      })),
      degradedRoots: await degradedSessionSearchRoots(swept.discoveries, issues, signal)
    }
  })
}

/** One entry per path, in the given priority order, always at its freshest stat. */
function readOrder(
  groups: readonly (readonly SessionFileCandidate[])[],
  freshest: readonly SessionFileCandidate[]
): SessionFileCandidate[] {
  const current = new Map(freshest.map((candidate) => [candidate.file.path, candidate]))
  const order: SessionFileCandidate[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const candidate of group) {
      const path = candidate.file.path
      if (!seen.has(path)) {
        seen.add(path)
        order.push(current.get(path) ?? candidate)
      }
    }
  }
  return order
}

/**
 * Turns the queue into candidates. An entry that names a path this cycle
 * discovered is already covered; one that does not is re-statted against what
 * the index recorded for it, so an invalidated file outside the recent window
 * is still re-read rather than waiting for the next sweep.
 */
async function queuedCandidates(
  store: SessionSearchStore,
  pending: readonly SessionSearchPendingFile[],
  recentPaths: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<{ candidates: SessionFileCandidate[]; unstattable: string[] }> {
  const candidates: SessionFileCandidate[] = []
  const unstattable: string[] = []
  const unresolved: string[] = []
  for (const entry of pending) {
    if (recentPaths.has(entry.path)) {
      continue
    }
    if (entry.candidate) {
      candidates.push(entry.candidate)
      continue
    }
    unresolved.push(entry.path)
  }
  for (const source of store.indexedSources(unresolved)) {
    if (signal?.aborted || !source.agent) {
      continue
    }
    const candidate = await restatCandidate(source.path, source.agent, source.codexHome, signal)
    if (candidate) {
      candidates.push(candidate)
    } else {
      unstattable.push(source.path)
    }
  }
  return { candidates, unstattable }
}

async function restatCandidate(
  path: string,
  agent: SessionFileCandidate['agent'],
  codexHome: string | null,
  signal?: AbortSignal
): Promise<SessionFileCandidate | null> {
  try {
    const fileStat = await wslGatedStat(path, 'scan', signal)
    return {
      agent,
      codexHome,
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
        sizeBytes: fileStat.size,
        dev: fileStat.dev,
        ino: fileStat.ino
      }
    }
  } catch {
    // Gone or unreadable: the retirement pass decides which, from the same stat.
    return null
  }
}
