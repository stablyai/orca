import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import {
  mergeDegradedRoots,
  scanIssueDegradedRoots,
  unreadableRoots,
  type SessionSearchDegradedRoot
} from './session-search-degraded-roots'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import {
  runSessionSearchIndexPass,
  type SessionSearchIndexPassResult
} from './session-search-index-pass'
import { createSessionParseStats } from '../ai-vault/session-scanner-parse-cache'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import {
  discoverSessionSearchCandidates,
  sessionSearchEmptiedRoots,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'

// Why 512: one directory walk each, only for paths outside the recent window,
// and only until the watch set drains. Large enough to converge in a handful of
// cycles on a 3,600-session machine, small enough not to be the cycle's cost.
const SESSION_SEARCH_RETIREMENT_CHECKS_PER_CYCLE = 512

export type SessionSearchReconcileArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  status: SessionSearchIndexingStatus
  /** The sidebar's own recency rule: the newest N transcripts per agent root. */
  recentPerAgent: number
  /** True once the pass is out of wall time; the rest comes back as `deferred`. */
  overdue?: () => boolean
  /** True for a file that has failed at this stat often enough to stop trying. */
  heldOut?: (candidate: SessionFileCandidate) => boolean
  onIndexed?: (candidate: SessionFileCandidate) => void
  onFailed?: (candidate: SessionFileCandidate) => void
  /** Paths the previous cycle watched; one missing from this one may be gone. */
  previousRecent: ReadonlySet<string>
  /** Real roots that listed transcripts on the previous pass; undefined before the first. */
  previousRootsWithFiles?: ReadonlySet<string>
  /** One readdir per directory per pass, shared with the rest of the pass. */
  listings: SessionSearchDirectoryReader
  signal?: AbortSignal
}

export type SessionSearchReconcileResult = {
  /** Real roots this cycle listed transcripts under, for the next pass to compare against. */
  rootsWithFiles: Set<string>
  /** What the next cycle watches: this cycle's recent window plus what it could not settle. */
  recentPaths: Set<string>
  /** Work drained from the queue and not read: out of time, or cut short by an abort. */
  deferred: SessionFileCandidate[]
  degradedRoots: SessionSearchDegradedRoot[]
  /** False when the cycle was aborted; its conclusions are not to be recorded. */
  completed: boolean
}

/**
 * One cycle. Re-stats the newest N per agent, folds in everything the store is
 * behind on, and reads whatever changed until the pass runs out of time. Files
 * outside the recent window are the periodic sweep's job, which is the only
 * promise a 20 s timer can actually keep on a machine with thousands of
 * transcripts and a 33 s cold discovery.
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
    // The one queue: files the index knows it is behind on, whether a read was
    // declined or a previous pass ran out of time before reaching them. Drained
    // here and put back below if this pass does not settle them, because a
    // drained entry that is never read is a hole in the index.
    const queued = store.takeStale()
    const forced = new Set(queued.map((candidate) => candidate.file.path))
    const owed = new Map(queued.map((candidate) => [candidate.file.path, candidate]))

    let completed = true
    let pass: SessionSearchIndexPassResult = { stats: createSessionParseStats(), deferred: [] }
    try {
      pass = await runSessionSearchIndexPass(
        store,
        // A hole in the index is more urgent than a file that only grew, so the
        // queue goes before the recency window.
        readOrder([queued, swept.candidates], swept.candidates),
        {
          signal,
          forced,
          overdue: args.overdue,
          heldOut: args.heldOut,
          onIndexed: (candidate, bytes) => {
            owed.delete(candidate.file.path)
            status.indexed(bytes)
            args.onIndexed?.(candidate)
          },
          onSkipped: (candidate) => owed.delete(candidate.file.path),
          onFailed: (candidate) => args.onFailed?.(candidate)
        }
      )
    } catch (error) {
      if (!signal?.aborted) {
        throw error
      }
      completed = false
    }
    for (const candidate of pass.deferred) {
      owed.set(candidate.file.path, candidate)
    }

    // The cycle retires rows too, through the same function and the same proof
    // rule as the sweep, because one interval is all it takes for a second rule
    // to undo the first one's care.
    const listings = sessionSearchRootListings(args.roots, swept.discoveries)
    const roots = listings.map((listing) => listing.root)
    const rootsWithFiles = new Set(
      listings.filter((listing) => listing.files > 0).map((listing) => listing.root)
    )
    // Undefined, not empty, before any pass has recorded one: an empty set is a
    // real observation and this is the absence of one.
    const previousRootsWithFiles = args.previousRootsWithFiles
    const retirement = completed
      ? await retireDeletedSessionSearchSources({
          store,
          paths: [...args.previousRecent].filter((path) => !recentPaths.has(path)),
          roots,
          emptiedRoots: previousRootsWithFiles
            ? sessionSearchEmptiedRoots(previousRootsWithFiles, rootsWithFiles)
            : new Set(),
          listings: args.listings,
          limit: SESSION_SEARCH_RETIREMENT_CHECKS_PER_CYCLE,
          signal
        })
      : { retired: [], unverifiable: [], unchecked: [], degradedRoots: [] }
    for (const path of retirement.retired) {
      owed.delete(path)
    }

    for (const refusal of cursorChatMetaRefusals()) {
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        message: refusal.message
      })
    }
    // Roots that listed no transcripts and cannot be listed either: the walker
    // swallows a readdir failure, so this is the only place it surfaces.
    const unlistable = await unreadableRoots(
      roots.filter((root) => !rootsWithFiles.has(root)),
      args.listings,
      signal
    )
    const degradedRoots = mergeDegradedRoots(
      scanIssueDegradedRoots(roots, issues),
      retirement.degradedRoots,
      unlistable
    )
    if (completed) {
      status.setDegradedRoots(degradedRoots)
    }

    return {
      rootsWithFiles,
      // An unreadable source is not a deleted one, and a path the cap did not
      // reach was never checked at all: both stay watched instead of being
      // retired or forgotten. A path proven present is settled and drops out.
      recentPaths: new Set([...recentPaths, ...retirement.unverifiable, ...retirement.unchecked]),
      deferred: [...owed.values()],
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
