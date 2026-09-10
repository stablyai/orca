import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
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
import { sessionSearchDiscoveredCounts } from './session-search-discovered-counts'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import type { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import {
  discoverSessionSearchCandidates,
  isUnderScanRoot,
  sessionSearchEmptiedRoots,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'

// One walk each, for paths the sweep did not discover. Normally near zero; the
// cap is there for the case that is not normal, an unmounted tree, where the
// list is the whole index and every entry is a candidate for deletion.
const RETIREMENT_CHECKS_PER_SWEEP = 512

export type SessionSearchBackfillArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  status: SessionSearchIndexingStatus
  /** Oldest transcript mtime worth indexing, or null for all history. */
  cutoffMs: number | null
  /** Real roots that listed transcripts on the previous pass; undefined before the first. */
  previousRootsWithFiles?: ReadonlySet<string>
  /** This pass's reading allowance; what does not fit comes back as `deferred`. */
  allowance?: SessionSearchCycleAllowance
  listings: SessionSearchDirectoryReader
  pace?: (signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type SessionSearchBackfillResult = {
  /**
   * Files the index holds under no root this scan is configured to walk, which
   * still exist on disk. Kept and reported rather than deleted.
   */
  orphanedFiles: number
  /** What the next pass watches: only what this one could not settle. */
  watchPaths: Set<string>
  /** Real roots this sweep listed transcripts under, for the next pass to compare against. */
  rootsWithFiles: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
  /** Discovered candidates the allowance had no room for, newest first. */
  deferred: SessionFileCandidate[]
  /** False when the sweep was aborted; it stays due until one finishes. */
  completed: boolean
}

/**
 * One whole-machine sweep. Every root, every transcript inside retention, in
 * newest-first order so the files a user is most likely to search for land
 * first. Progress lives in the index's own `files` table rather than in memory,
 * so an interrupted sweep resumes here instead of starting over: the pass skips
 * anything the index already covers at its current stat.
 *
 * The reading is budgeted like a cycle's. A first run has a whole disk to get
 * through and the process it runs in also serves a UI, so the sweep spends one
 * allowance and hands the rest back; the caller keeps feeding it an allowance
 * per pass until it drains. Discovery, health and retirement all complete on
 * this pass either way — they are what the sweep is uniquely for.
 */
export async function runSessionSearchBackfill(
  args: SessionSearchBackfillArgs
): Promise<SessionSearchBackfillResult> {
  const { store, status, signal } = args
  status.beginSweep()
  args.allowance?.reset()
  await store.purgeOlderThan(args.cutoffMs, signal)
  await ensureSessionParseCacheLoaded()
  return withCursorChatMetaScan(async () => {
    const swept = await discoverSessionSearchCandidates(args.roots, {
      limitPerAgent: Number.POSITIVE_INFINITY,
      signal
    })
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const eligible = swept.candidates.filter((candidate) => store.acceptsCandidate(candidate))
    status.setDiscovered(sessionSearchDiscoveredCounts(swept.discoveries, issues))
    status.planned(eligible.length, issues.length)

    let completed = true
    let deferred: SessionFileCandidate[] = []
    try {
      const pass = await runSessionSearchIndexPass(store, eligible, {
        signal,
        pace: args.pace,
        allowance: args.allowance,
        onIndexed: (_candidate, bytes) => status.indexed(bytes),
        onFailed: () => status.failed()
      })
      deferred = pass.deferred
    } catch (error) {
      if (!signal?.aborted) {
        throw error
      }
      completed = false
    }

    for (const refusal of cursorChatMetaRefusals()) {
      // One issue per refused chats root, not one per Cursor transcript.
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        message: refusal.message
      })
    }
    const listings = sessionSearchRootListings(args.roots, swept.discoveries)
    const roots = listings.map((listing) => listing.root)
    const rootsWithFiles = new Set(
      listings.filter((listing) => listing.files > 0).map((listing) => listing.root)
    )
    // Undefined, not empty, before any pass has recorded one: an empty set is
    // a real observation and this is the absence of one.
    const previousRootsWithFiles = args.previousRootsWithFiles
    const discoveredPaths = new Set(swept.candidates.map((candidate) => candidate.file.path))
    const held = completed ? store.indexedSources().map((source) => source.path) : []
    const undiscovered = held.filter((path) => !discoveredPaths.has(path))
    // A path this scan walks no root for: the profile moved, a root was
    // reconfigured, or an agent's store relocated between releases. It retires
    // exactly like any other row if its own directory lists without it, and
    // otherwise the rows stay and the count is reported, because an index
    // holding content the configuration cannot reach is a problem to surface
    // rather than a licence to delete a user's history. Nothing refreshes those
    // rows, so `orphanedFiles` is the only honest signal that they are there.
    const orphans = new Set(
      undiscovered.filter((path) => !roots.some((root) => isUnderScanRoot(path, root)))
    )
    // An aborted sweep saw part of the machine, so its silence about a path is
    // not evidence; it retires nothing and publishes no verdicts.
    const retirement = completed
      ? await retireDeletedSessionSearchSources({
          store,
          paths: undiscovered,
          roots,
          emptiedRoots: previousRootsWithFiles
            ? sessionSearchEmptiedRoots(previousRootsWithFiles, rootsWithFiles)
            : new Set(),
          listings: args.listings,
          limit: RETIREMENT_CHECKS_PER_SWEEP,
          signal
        })
      : { retired: [], unverifiable: [], unchecked: [], degradedRoots: [] }

    // Roots that listed no transcripts and cannot be listed either: the walker
    // swallows a readdir failure, so this is the only place it surfaces.
    const unlistable = completed
      ? await unreadableRoots(
          roots.filter((root) => !rootsWithFiles.has(root)),
          args.listings,
          signal
        )
      : []

    const degradedRoots = mergeDegradedRoots(
      scanIssueDegradedRoots(roots, issues),
      retirement.degradedRoots,
      unlistable
    )
    const orphanedFiles = [...orphans].filter((path) => !retirement.retired.includes(path)).length
    if (completed) {
      // Only a sweep that finished publishes: an aborted one saw part of the
      // machine, and its empty findings would clear a live alarm.
      status.setDegradedRoots(degradedRoots)
      status.setOrphanedFiles(orphanedFiles)
    }

    return {
      orphanedFiles,
      // Only what this pass could not settle. Watching every discovered path
      // would make the next cycle re-walk the whole machine to learn nothing:
      // an old file deleted between two sweeps is the next sweep's to find,
      // which is the same promise the recency window already makes.
      watchPaths: new Set([...retirement.unverifiable, ...retirement.unchecked]),
      rootsWithFiles,
      degradedRoots,
      deferred,
      completed
    }
  })
}
