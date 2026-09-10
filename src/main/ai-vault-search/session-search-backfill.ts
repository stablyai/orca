import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
import { SessionNewestFiles } from '../ai-vault/session-newest-files'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import type { SessionFileCandidate, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import {
  mergeDegradedRoots,
  scanIssueDegradedRoots,
  unreadableRoots,
  type SessionSearchDegradedRoot
} from './session-search-degraded-roots'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import {
  discoverSessionSearchCandidates,
  sessionSearchEmptiedRoots,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'
import { sessionSearchEnumeratedContainers } from './session-search-synthetic-sources'

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
  /** The recency rule the cycles after this sweep will apply; seeds their watch set. */
  recentPerAgent: number
  /** Real roots that listed transcripts on the previous pass; undefined before the first. */
  previousRootsWithFiles?: ReadonlySet<string>
  /** True once the pass is out of wall time; the rest comes back as `deferred`. */
  overdue?: () => boolean
  /** True for a file that has failed at this stat often enough to stop trying. */
  heldOut?: (candidate: SessionFileCandidate) => boolean
  onIndexed?: (candidate: SessionFileCandidate) => void
  onFailed?: (candidate: SessionFileCandidate) => void
  listings: SessionSearchDirectoryReader
  signal?: AbortSignal
}

export type SessionSearchBackfillResult = {
  /**
   * What the next pass watches: this sweep's own recency window, plus anything
   * it could not settle.
   *
   * The window has to be in here. A cycle proves a deletion by comparing what
   * the previous pass watched against what it discovers, so a sweep that
   * watched nothing leaves the cycle after it with no candidates at all, and a
   * transcript deleted in that interval survives until the next sweep.
   */
  watchPaths: Set<string>
  /** Real roots this sweep listed transcripts under, for the next pass to compare against. */
  rootsWithFiles: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
  /** Discovered candidates the deadline left unread, newest first. */
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
 * The reading is bounded by the same wall-clock deadline every pass gets. A
 * first run has a whole disk to get through and the process it runs in also
 * serves a UI, so the sweep reads until its deadline and hands the rest back as
 * `deferred`. Discovery, health and retirement all complete on this pass either
 * way — they are what the sweep is uniquely for.
 */
export async function runSessionSearchBackfill(
  args: SessionSearchBackfillArgs
): Promise<SessionSearchBackfillResult> {
  const { store, status, signal } = args
  status.beginSweep()
  // Every full sweep opens with the purge, so a narrower retention window than
  // the last instance held is applied by the first sweep of this one.
  await store.purgeOlderThan(args.cutoffMs, signal)
  await ensureSessionParseCacheLoaded()
  return withCursorChatMetaScan(async () => {
    const swept = await discoverSessionSearchCandidates(args.roots, {
      limitPerAgent: Number.POSITIVE_INFINITY,
      signal
    })
    const issues: AiVaultScanIssue[] = [...swept.issues]
    const eligible = swept.candidates.filter((candidate) => store.acceptsCandidate(candidate))

    let completed = true
    let deferred: SessionFileCandidate[] = []
    try {
      const pass = await runSessionSearchIndexPass(store, eligible, {
        signal,
        overdue: args.overdue,
        heldOut: args.heldOut,
        onIndexed: (candidate, bytes) => {
          status.indexed(bytes)
          args.onIndexed?.(candidate)
        },
        onFailed: (candidate) => args.onFailed?.(candidate)
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
    let held: string[] = []
    if (completed) {
      try {
        held = store.indexedSources().map((source) => source.path)
      } catch (error) {
        // A handle that cannot be read proves nothing about what is missing, so
        // this sweep concludes nothing and does not count as one that finished.
        if (!signal?.aborted) {
          throw error
        }
        completed = false
      }
    }
    // Rows the sweep did not rediscover, including any under no root this scan
    // walks: the walk judges each on its own directory and proves nothing about
    // one it cannot reach, so a reconfigured root keeps its rows rather than
    // losing them.
    const undiscovered = held.filter((path) => !discoveredPaths.has(path))
    // An aborted sweep saw part of the machine, so its silence about a path is
    // not evidence; it retires nothing and publishes no verdicts.
    const retirement = completed
      ? await retireDeletedSessionSearchSources({
          store,
          paths: undiscovered,
          roots,
          // Only a sweep enumerates without a per-agent limit, so only a sweep
          // may prove a synthetic row's container holds it no longer.
          enumeratedContainers: sessionSearchEnumeratedContainers(swept.candidates, issues),
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
    if (completed) {
      // Only a sweep that finished publishes: an aborted one saw part of the
      // machine, and its empty findings would clear a live alarm.
      status.setDegradedRoots(degradedRoots)
      // A drop says the queue is knowingly missing something. This pass just
      // re-enumerated every root, so anything still owed is back on the queue
      // and a drop from before it no longer describes the queue. What this
      // sweep hands back, and the queue cannot hold, is counted again: the
      // caller re-queues it after this returns.
      store.forgetDroppedPending()
    }

    return {
      // This sweep's recency window, plus what it could not settle. Not every
      // discovered path: that would make the next cycle re-walk the whole
      // machine to learn nothing, and an old file deleted between two sweeps is
      // the next sweep's to find, which is the promise the window already makes.
      watchPaths: new Set([
        ...(completed ? recentWindowPaths(swept.discoveries, args.recentPerAgent) : []),
        ...retirement.unverifiable,
        ...retirement.unchecked
      ]),
      rootsWithFiles,
      degradedRoots,
      deferred,
      completed
    }
  })
}

/**
 * The paths a cycle's own discovery would return, taken from this sweep's.
 *
 * The same selection, through the same class discovery applies it with and per
 * the same unit it applies it to — one discovery, which is one root, or the set
 * of alternates a merged discovery reports as one. Re-running discovery under
 * the cycle's limit would walk every tree a second time; spelling the rule out
 * here would be a second spelling of it.
 */
function recentWindowPaths(
  discoveries: readonly SessionFileDiscovery[],
  recentPerAgent: number
): string[] {
  return discoveries.flatMap((discovery) => {
    const newest = new SessionNewestFiles(recentPerAgent)
    for (const file of discovery.files) {
      newest.add(file)
    }
    return newest.newest().map((file) => file.path)
  })
}
