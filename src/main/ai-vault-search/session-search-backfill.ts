import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { sessionSearchDiscoveredCounts } from './session-search-discovered-counts'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import {
  sessionSearchRootHealth,
  type SessionSearchDegradedRoot,
  type SessionSearchRootState
} from './session-search-root-health'
import {
  discoverSessionSearchCandidates,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'

// One stat each, for paths the sweep did not discover. Normally near zero; the
// cap is there for the case that is not normal, an unmounted tree, where the
// list is the whole index and every entry is a candidate for deletion.
const RETIREMENT_CHECKS_PER_SWEEP = 512

export type SessionSearchBackfillArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  status: SessionSearchIndexingStatus
  /** Oldest transcript mtime worth indexing, or null for all history. */
  cutoffMs: number | null
  /** What the last sweeps saw of each root, so a tree that went empty is visible. */
  previousRootStates?: ReadonlyMap<string, SessionSearchRootState>
  pace?: (signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type SessionSearchBackfillResult = {
  /**
   * Files the index holds under no root this scan is configured to walk, which
   * still exist on disk. Kept and reported rather than deleted.
   */
  orphanedFiles: number
  /** Paths to watch for disappearance, plus whatever this sweep could not settle. */
  watchPaths: Set<string>
  rootStates: Map<string, SessionSearchRootState>
  degradedRoots: SessionSearchDegradedRoot[]
  /** False when the sweep was aborted; it stays due until one finishes. */
  completed: boolean
}

/**
 * One whole-machine sweep. Every root, every transcript inside retention, in
 * newest-first order so the files a user is most likely to search for land
 * first. Progress lives in the index's own `files` table rather than in memory,
 * so an interrupted sweep resumes here instead of starting over: the pass skips
 * anything the index already covers at its current stat.
 */
export async function runSessionSearchBackfill(
  args: SessionSearchBackfillArgs
): Promise<SessionSearchBackfillResult> {
  const { store, status, signal } = args
  status.beginSweep()
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
    try {
      await runSessionSearchIndexPass(store, eligible, {
        signal,
        pace: args.pace,
        onIndexed: (_candidate, bytes) => status.indexed(bytes),
        onFailed: () => status.failed()
      })
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
    const previousStates = args.previousRootStates ?? new Map()
    // An aborted sweep saw part of the machine. It does not probe, it does not
    // judge, and it does not carry an observation into the tally that decides a
    // root was emptied: two interrupted passes must not add up to a conclusion
    // no completed pass ever reached.
    const health = completed
      ? await sessionSearchRootHealth({
          listings,
          issues,
          holdsFiles: (root) => store.hasIndexedFilesUnder(root),
          previous: previousStates,
          // A sweep walks every root without a limit, so it is the observation
          // allowed to conclude that a root really was emptied.
          census: true,
          signal
        })
      : { degraded: [], states: new Map(previousStates) }
    const degradedRoots = health.degraded
    const discoveredPaths = new Set(swept.candidates.map((candidate) => candidate.file.path))
    const held = completed ? store.indexedSources().map((source) => source.path) : []
    const undiscovered = held.filter((path) => !discoveredPaths.has(path))
    const orphans = new Set(
      undiscovered.filter((path) => !listings.some((listing) => underRoot(path, listing.root)))
    )
    const retirement = completed
      ? await retireDeletedSessionSearchSources(store, undiscovered, {
          signal,
          limit: RETIREMENT_CHECKS_PER_SWEEP,
          degradedRoots
        })
      : { retired: [], unverifiable: [], unchecked: [] }

    return {
      orphanedFiles: [...orphans].filter((path) => !retirement.retired.includes(path)).length,
      watchPaths: new Set([
        ...discoveredPaths,
        ...retirement.unverifiable,
        ...retirement.unchecked
      ]),
      rootStates: health.states,
      degradedRoots,
      completed
    }
  })
}

/**
 * A path this scan walks no root for: the profile moved, a root was
 * reconfigured, or an agent's store relocated between releases.
 *
 * The rule, one rule, and why it is not "delete it": such a file is retired
 * exactly like any other if its path answers ENOENT, because that is proof.
 * If it is still on disk, the rows stay and the count is reported, because the
 * index holding content the current configuration cannot reach is a
 * configuration problem to surface, not a licence to delete a user's
 * searchable history. Nothing refreshes those rows, so `orphanedFiles` is the
 * only honest signal that they are there.
 */
function underRoot(path: string, root: string): boolean {
  return root.length > 0 && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
}
