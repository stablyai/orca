import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import {
  runSessionSearchIndexPass,
  type SessionSearchIndexPassResult
} from './session-search-index-pass'
import { createSessionParseStats } from '../ai-vault/session-scanner-parse-cache'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import type { SessionSearchPendingFile } from './session-search-pending-files'
import type { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import {
  sessionSearchRootHealth,
  type SessionSearchDegradedRoot,
  type SessionSearchRootState
} from './session-search-root-health'
import {
  discoverSessionSearchCandidates,
  sessionSearchAgentForPath,
  sessionSearchRootListings,
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
  /** What the last sweeps saw of each root; read, never written, by a cycle. */
  previousRootStates?: ReadonlyMap<string, SessionSearchRootState>
  signal?: AbortSignal
}

export type SessionSearchReconcileResult = {
  /** What the next cycle watches: this cycle's recent window plus what it could not settle. */
  recentPaths: Set<string>
  /** Work drained but not read: over budget, unresolved, or cut short by an abort. */
  deferred: SessionSearchPendingFile[]
  degradedRoots: SessionSearchDegradedRoot[]
  /** False when the cycle was aborted; its conclusions are not to be recorded. */
  completed: boolean
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
    const queued = await queuedCandidates(args, recentPaths, signal)
    const stale = store.takeStale()
    const forced = new Set([
      ...stale.map((candidate) => candidate.file.path),
      ...args.pending.filter((entry) => entry.forced).map((entry) => entry.path)
    ])
    // Everything drained out of a queue, so an abort can put back exactly what
    // it did not get to. A drained entry that is never read is a hole in the
    // index, and dropping it is how a file stays missing until the next sweep.
    // Which queue it came from is tracked, because they are not the same size:
    // the store holds ten times what this one does, so returning its overflow
    // here would quietly discard the difference.
    const owed = new Map<string, { entry: SessionSearchPendingFile; fromStore: boolean }>()
    for (const entry of args.pending) {
      owed.set(entry.path, { entry, fromStore: false })
    }
    for (const candidate of stale) {
      const entry = { path: candidate.file.path, candidate, forced: true }
      owed.set(candidate.file.path, { entry, fromStore: true })
    }

    let completed = true
    let pass: SessionSearchIndexPassResult = { stats: createSessionParseStats(), deferred: [] }
    try {
      pass = await runSessionSearchIndexPass(
        store,
        // A hole in the index is more urgent than a file that only grew, and
        // rolled-over work waited a cycle already, so both go before discovery.
        readOrder([stale, queued.candidates, swept.candidates], swept.candidates),
        {
          signal,
          forced,
          allowance: args.allowance,
          onIndexed: (candidate, bytes) => {
            owed.delete(candidate.file.path)
            status.indexed(bytes)
          },
          onSkipped: (candidate) => owed.delete(candidate.file.path),
          onFailed: () => status.failed()
        }
      )
    } catch (error) {
      if (!signal?.aborted) {
        throw error
      }
      completed = false
    }
    for (const candidate of pass.deferred) {
      const path = candidate.file.path
      const entry = { path, candidate, forced: forced.has(path) }
      owed.set(path, { entry, fromStore: owed.get(path)?.fromStore ?? false })
    }
    for (const path of queued.unresolved) {
      // Never silently dropped: a caller asked for this path and the index has
      // no record of it, so it stays queued and keeps being counted.
      owed.set(path, { entry: { path, candidate: null, forced: true }, fromStore: false })
    }

    // Before the retirement, not after it: the cycle deletes rows too, so it
    // needs the same fence the sweep has or one interval undoes the sweep's care.
    const degradedRoots = (
      await sessionSearchRootHealth({
        listings: sessionSearchRootListings(args.roots, swept.discoveries),
        issues,
        holdsFiles: (root) => store.hasIndexedFilesUnder(root),
        previous: args.previousRootStates ?? new Map(),
        // A recent-window discovery can see a root that went to zero, but it is
        // not a census and must never conclude one was emptied.
        census: false,
        signal
      })
    ).degraded
    const retirement = completed
      ? await retireDeletedSessionSearchSources(
          store,
          [...new Set([...args.previousRecent, ...queued.unstattable])].filter(
            (path) => !recentPaths.has(path)
          ),
          {
            signal,
            limit: args.retirementChecksPerCycle ?? DEFAULT_SESSION_SEARCH_RETIREMENT_CHECKS,
            degradedRoots
          }
        )
      : { retired: [], unverifiable: [], unchecked: [] }
    for (const path of retirement.retired) {
      owed.delete(path)
    }
    // A record that came from the store goes back to the store, which applies
    // its own retention rule and its own, larger bound.
    const deferred: SessionSearchPendingFile[] = []
    for (const { entry, fromStore } of owed.values()) {
      if (fromStore && entry.candidate) {
        store.markStale(entry.candidate)
        continue
      }
      deferred.push(entry)
    }

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
      deferred,
      degradedRoots,
      completed
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
 * discovered is already covered; one that does not is re-statted, with the
 * agent taken from what the index recorded or, for a path the index has never
 * held, from the same root table discovery reads. What still cannot be resolved
 * is reported rather than dropped.
 */
async function queuedCandidates(
  args: SessionSearchReconcileArgs,
  recentPaths: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<{ candidates: SessionFileCandidate[]; unstattable: string[]; unresolved: string[] }> {
  const candidates: SessionFileCandidate[] = []
  const unstattable: string[] = []
  const unresolved: string[] = []
  const byPath: string[] = []
  for (const entry of args.pending) {
    if (recentPaths.has(entry.path)) {
      continue
    }
    if (entry.candidate) {
      candidates.push(entry.candidate)
      continue
    }
    byPath.push(entry.path)
  }
  const indexed = new Map(args.store.indexedSources(byPath).map((source) => [source.path, source]))
  for (const path of byPath) {
    if (signal?.aborted) {
      unresolved.push(path)
      continue
    }
    const source = indexed.get(path)
    const agent = source?.agent ?? sessionSearchAgentForPath(args.roots, path)
    if (!agent) {
      unresolved.push(path)
      continue
    }
    const candidate = await restatCandidate(path, agent, source?.codexHome ?? null, signal)
    if (candidate) {
      candidates.push(candidate)
    } else if (source) {
      // The index holds rows for it, so whether it is gone is a real question.
      unstattable.push(path)
    } else {
      unresolved.push(path)
    }
  }
  return { candidates, unstattable, unresolved }
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
