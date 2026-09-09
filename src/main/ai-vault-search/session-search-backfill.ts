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
  degradedSessionSearchRoots,
  rootFileCounts,
  underDegradedRoot,
  type SessionSearchDegradedRoot
} from './session-search-root-health'
import {
  discoverSessionSearchCandidates,
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
  /** What each root listed last sweep, so a tree that went empty is visible. */
  previousRootFileCounts?: ReadonlyMap<string, number>
  pace?: (signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type SessionSearchBackfillResult = {
  /** Paths to watch for disappearance, plus whatever this sweep could not settle. */
  watchPaths: Set<string>
  rootFileCounts: Map<string, number>
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
    const counts = rootFileCounts(swept.discoveries)
    const degradedRoots = await degradedSessionSearchRoots(swept.discoveries, issues, {
      signal,
      previousFileCounts: args.previousRootFileCounts
    })
    const discoveredPaths = new Set(swept.candidates.map((candidate) => candidate.file.path))
    const retirement = completed
      ? await retireSweptAwaySources(args, discoveredPaths, degradedRoots)
      : { retired: [], unverifiable: [], unchecked: [] }

    return {
      watchPaths: new Set([
        ...discoveredPaths,
        ...retirement.unverifiable,
        ...retirement.unchecked
      ]),
      rootFileCounts: counts,
      degradedRoots,
      completed
    }
  })
}

/**
 * A sweep is the only pass that sees every root, so it is the only one that can
 * retire a source deleted while nothing was running. It is also the pass that
 * would delete a user's entire searchable history the first time an SSH mount
 * or an external drive is not there, because every path under it answers ENOENT
 * at once. A degraded root's files are therefore never retired, however loudly
 * the filesystem says they are gone
 * (docs/reference/ssh-execution-boundary.md).
 */
async function retireSweptAwaySources(
  args: SessionSearchBackfillArgs,
  discoveredPaths: ReadonlySet<string>,
  degradedRoots: readonly SessionSearchDegradedRoot[]
): Promise<{ retired: string[]; unverifiable: string[]; unchecked: string[] }> {
  const undiscovered = args.store
    .indexedSources()
    .map((source) => source.path)
    .filter((path) => !discoveredPaths.has(path) && !underDegradedRoot(path, degradedRoots))
  return retireDeletedSessionSearchSources(args.store, undiscovered, {
    signal: args.signal,
    limit: RETIREMENT_CHECKS_PER_SWEEP
  })
}
