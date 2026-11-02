import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../ai-vault/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import {
  mergeDegradedRoots,
  scanIssueDegradedRoots,
  unreadableRoots,
  type SessionSearchDegradedRoot
} from './session-search-degraded-roots'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import {
  discoverSessionSearchCandidates,
  isUnderScanRoot,
  sessionSearchEmptiedRoots,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from './session-search-scan-roots'
import type { SessionSearchFileRow, SessionSearchStore } from './session-search-store'
import { sessionSearchEnumeratedContainers } from './session-search-synthetic-sources'

// Bound recent-cycle retirement work and prioritize rows within the recency window.
const RETIREMENT_ROWS_PER_CYCLE = 512

// Count directory reads so many rows under one unreadable directory cannot exhaust the budget.
const RETIREMENT_DIRECTORIES_PER_PASS = 512

export type SessionSearchPassArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  /** A sweep lists every root; a cycle lists the newest N per agent. */
  full: boolean
  recentPerAgent: number
  /** Roots with transcripts on the previous pass; undefined before any observation. */
  previousRootsWithFiles?: ReadonlySet<string>
  /** The deadline stops transcript reads; discovery and retirement still finish. */
  overdue?: () => boolean
  /** Cache directory reads across discovery-health and retirement checks for this pass. */
  listings: SessionSearchDirectoryReader
  signal?: AbortSignal
}

export type SessionSearchPassResult = {
  /** Roots with discovered transcripts, retained to detect newly emptied roots. */
  rootsWithFiles: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
  /** Ignore health findings from an incomplete pass. */
  completed: boolean
  /** Deferred reads require another sweep to reach backlog outside the recent window. */
  outOfTime: boolean
  /** Deferred candidates excluding due rows, which status already counts from the database. */
  left: number
}

export async function runSessionSearchPass(
  args: SessionSearchPassArgs
): Promise<SessionSearchPassResult> {
  const { store, signal } = args
  if (args.full) {
    // Apply narrowed retention before the new instance’s first discovery.
    await store.purgeOlderThan(store.retentionCutoff, signal)
  }
  return withCursorChatMetaScan(async () => {
    const swept = await discoverSessionSearchCandidates(args.roots, {
      limitPerAgent: args.full ? Number.POSITIVE_INFINITY : args.recentPerAgent,
      signal
    })
    const issues: AiVaultScanIssue[] = [...swept.issues]

    let completed = true
    let outOfTime = false
    let left = 0
    const rows = new Map(store.files().map((row) => [row.path, row]))
    try {
      const read = await runSessionSearchIndexPass(store, swept.candidates, {
        signal,
        rows,
        overdue: args.overdue
      })
      outOfTime = read.outOfTime
      left = read.left
    } catch (error) {
      if (!signal?.aborted) {
        throw error
      }
      completed = false
    }

    const listings = sessionSearchRootListings(args.roots, swept.discoveries)
    const roots = listings.map((listing) => listing.root)
    const rootsWithFiles = new Set(
      listings.filter((listing) => listing.files > 0).map((listing) => listing.root)
    )
    const previousRootsWithFiles = args.previousRootsWithFiles
    // An incomplete read pass cannot prove deletions or clear degraded-root findings.
    const retirement = completed
      ? await retireDeletedSessionSearchSources({
          store,
          paths: retirementCandidates(rows, swept, roots, args.full),
          roots,
          // Only unlimited discovery can prove a synthetic session is absent from its container.
          enumeratedContainers: args.full
            ? sessionSearchEnumeratedContainers(swept.candidates, issues)
            : undefined,
          emptiedRoots: previousRootsWithFiles
            ? sessionSearchEmptiedRoots(previousRootsWithFiles, rootsWithFiles)
            : new Set(),
          listings: args.listings,
          directoryLimit: RETIREMENT_DIRECTORIES_PER_PASS,
          signal
        })
      : { retired: [], unverifiable: [], unchecked: [], degradedRoots: [] }

    for (const refusal of cursorChatMetaRefusals()) {
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        ...refusal.text
      })
    }
    // Discovery suppresses readdir failures; check empty roots explicitly to expose those failures.
    const unlistable = completed
      ? await unreadableRoots(
          roots.filter((root) => !rootsWithFiles.has(root)),
          args.listings,
          signal
        )
      : []

    return {
      rootsWithFiles,
      degradedRoots: mergeDegradedRoots(
        scanIssueDegradedRoots(roots, issues),
        retirement.degradedRoots,
        unlistable
      ),
      completed,
      outOfTime,
      left
    }
  })
}

/** Retire undiscovered rows; recent cycles check only the newest rows under discovered roots. */
function retirementCandidates(
  rows: ReadonlyMap<string, SessionSearchFileRow>,
  swept: { candidates: readonly { file: { path: string } }[] },
  roots: readonly string[],
  full: boolean
): string[] {
  const discovered = new Set(swept.candidates.map((candidate) => candidate.file.path))
  const undiscovered = [...rows.values()].filter((row) => !discovered.has(row.path))
  if (full) {
    return undiscovered.map((row) => row.path)
  }
  return undiscovered
    .filter((row) => roots.some((root) => isUnderScanRoot(row.path, root)))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, RETIREMENT_ROWS_PER_CYCLE)
    .map((row) => row.path)
}
