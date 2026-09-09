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
  type SessionSearchDegradedRoot
} from './session-search-root-health'
import {
  discoverSessionSearchCandidates,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchStore } from './session-search-store'

export type SessionSearchBackfillArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  status: SessionSearchIndexingStatus
  /** Oldest transcript mtime worth indexing, or null for all history. */
  cutoffMs: number | null
  pace?: (signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type SessionSearchBackfillResult = {
  /** Every path the sweep saw, so the next cycle can tell a deletion from a cap. */
  discoveredPaths: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
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

    await runSessionSearchIndexPass(store, eligible, {
      signal,
      pace: args.pace,
      onIndexed: (_candidate, bytes) => status.indexed(bytes),
      onFailed: () => status.failed()
    })

    const discoveredPaths = new Set(swept.candidates.map((candidate) => candidate.file.path))
    // A sweep is the only pass that sees every root, so it is the only one that
    // can retire a source deleted while nothing was running.
    await retireDeletedSessionSearchSources(
      store,
      store
        .indexedSources()
        .map((source) => source.path)
        .filter((path) => !discoveredPaths.has(path)),
      { signal }
    )

    for (const refusal of cursorChatMetaRefusals()) {
      // One issue per refused chats root, not one per Cursor transcript.
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        message: refusal.message
      })
    }
    return {
      discoveredPaths,
      degradedRoots: await degradedSessionSearchRoots(swept.discoveries, issues, signal)
    }
  })
}
