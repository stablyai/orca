import { SessionSearchRecentRetirements } from './session-search-recent-retirements'
import type { AiVaultScanIssue } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from '../../ai-vault/scanners/cursor/session-scanner-cursor-chat-meta'
import { recordSessionScanIssue } from '../../ai-vault/parsing/session-scan-issues'
import {
  mergeDegradedRoots,
  scanIssueDegradedRoots,
  unreadableRoots,
  type SessionSearchDegradedRoot
} from '../discovery/session-search-degraded-roots'
import { retireDeletedSessionSearchSources } from '../discovery/session-search-deleted-sources'
import type { SessionSearchDirectoryReader } from '../discovery/session-search-directory-listings'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import { throwIfAiVaultScanCancelled } from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import { fileIdentity } from '../storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import {
  discoverSessionSearchCandidates,
  isUnderScanRoot,
  sessionSearchEmptiedRoots,
  sessionSearchRootListings,
  type SessionSearchScanRoots
} from '../discovery/session-search-scan-roots'
import type { SessionSearchIndexStore } from '../storage/session-search-store-types'
import { sessionSearchEnumeratedContainers } from '../discovery/session-search-synthetic-sources'

// Bound recent-cycle retirement work and prioritize rows within the recency window.
const RETIREMENT_ROWS_PER_CYCLE = 512

// Count directory reads so many rows under one unreadable directory cannot exhaust the budget.
const RETIREMENT_DIRECTORIES_PER_PASS = 512

export type SessionSearchPeriodicPassArgs = {
  store: SessionSearchIndexStore
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

export type SessionSearchPeriodicPassResult = {
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

export async function runSessionSearchPeriodicPass(
  args: SessionSearchPeriodicPassArgs
): Promise<SessionSearchPeriodicPassResult> {
  const { store, signal } = args
  await store.prepare?.()
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
    try {
      const read = await readPeriodicCandidates(store, swept.candidates, args)
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
    // An incomplete read pass cannot prove deletions or clear degraded-root findings.
    const retirement = completed
      ? await retirePeriodicSources(args, swept.candidates, roots, rootsWithFiles, issues)
      : []

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

    await store.flush?.()
    return {
      rootsWithFiles,
      degradedRoots: mergeDegradedRoots(
        scanIssueDegradedRoots(roots, issues),
        retirement,
        unlistable
      ),
      completed,
      outOfTime,
      left
    }
  })
}

async function readPeriodicCandidates(
  store: SessionSearchIndexStore,
  candidates: readonly SessionFileCandidate[],
  args: SessionSearchPeriodicPassArgs
): Promise<{ outOfTime: boolean; left: number }> {
  const stats = createSessionParseStats()
  let read = 0,
    left = 0,
    outOfTime = false
  for (let start = 0; start < candidates.length; start += 256) {
    const page = candidates.slice(start, start + 256)
    throwIfAiVaultScanCancelled(args.signal)
    await store.prepareCoverage?.(page.map(({ file }) => file.path))
    for (const candidate of page) {
      throwIfAiVaultScanCancelled(args.signal)
      const path = candidate.file.path
      // Read deltas and the byte bound can evict coverage within the current page.
      if (store.coverageKnown?.(path) === false) {
        await store.prepareCoverage?.([path])
      }
      const row = store.fileRow(path)
      const decision = sessionSearchReadDecision({
        candidate,
        row,
        cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
        cutoffMs: store.retentionCutoff
      })
      if (decision === 'skip') {
        continue
      }
      outOfTime ||= read > 0 && args.overdue?.() === true
      if (outOfTime) {
        if (row?.state !== 'due') {
          left++
        }
        continue
      }
      throwIfAiVaultScanCancelled(args.signal)
      read++
      try {
        await parseAgentSessionFileCached(
          candidate,
          process.platform,
          stats,
          decision,
          args.signal,
          true
        )
        await store.flush?.()
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        console.warn(
          '[ai-vault-search] indexing skipped',
          candidate.agent,
          error instanceof Error ? error.name : 'ParseError'
        )
      }
    }
  }
  return { outOfTime, left }
}

async function retirePeriodicSources(
  args: SessionSearchPeriodicPassArgs,
  candidates: readonly SessionFileCandidate[],
  roots: readonly string[],
  rootsWithFiles: ReadonlySet<string>,
  issues: readonly AiVaultScanIssue[]
): Promise<SessionSearchDegradedRoot[]> {
  const discovered = new Set(candidates.map(({ file }) => file.path))
  const directoryBudget = { asked: new Set<string>(), exhausted: false }
  const degraded = new Map<string, SessionSearchDegradedRoot>()
  const enumeratedContainers = args.full
    ? sessionSearchEnumeratedContainers(candidates, issues)
    : undefined
  const emptiedRoots = args.previousRootsWithFiles
    ? sessionSearchEmptiedRoots(args.previousRootsWithFiles, rootsWithFiles)
    : new Set<string>()
  const retire = async (paths: string[]) => {
    const result = await retireDeletedSessionSearchSources({
      store: args.store,
      paths,
      roots,
      enumeratedContainers,
      emptiedRoots,
      listings: args.listings,
      directoryLimit: RETIREMENT_DIRECTORIES_PER_PASS,
      directoryBudget,
      signal: args.signal
    })
    for (const root of result.degradedRoots) {
      if (!degraded.has(root.root)) {
        degraded.set(root.root, root)
      }
    }
  }
  let paths: string[] = []
  const recent = new SessionSearchRecentRetirements(RETIREMENT_ROWS_PER_CYCLE)
  for await (const row of args.store.fileRows()) {
    if (args.signal?.aborted) {
      break
    }
    if (discovered.has(row.path)) {
      continue
    }
    if (args.full) {
      paths.push(row.path)
      if (paths.length === 256) {
        await retire(paths)
        paths = []
        if (directoryBudget.exhausted) {
          break
        }
      }
    } else if (roots.some((root) => isUnderScanRoot(row.path, root))) {
      recent.add(row)
    }
  }
  if (!args.full) {
    paths = recent.paths()
  }
  if (paths.length) {
    await retire(paths)
  }
  return [...degraded.values()]
}
