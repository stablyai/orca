import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
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

/**
 * Rows a cycle proves present or gone, newest first.
 *
 * Why bounded and why newest first: a cycle lists the newest N per agent, so
 * every older row it holds is undiscovered and would otherwise be walked every
 * twenty seconds. Newest first is what makes the guarantee hold — a transcript
 * recent enough for the window to cover is recent enough to be in this slice,
 * so its deletion is proven on the very next cycle whenever it happened.
 */
const RETIREMENT_CHECKS_PER_CYCLE = 512

/** One walk each for every row a sweep did not rediscover; see the cycle's note. */
const RETIREMENT_CHECKS_PER_SWEEP = 512

export type SessionSearchPassArgs = {
  store: SessionSearchStore
  roots: SessionSearchScanRoots
  /** A sweep lists every root; a cycle lists the newest N per agent. */
  full: boolean
  recentPerAgent: number
  /** Real roots that listed transcripts on the previous pass; undefined before the first. */
  previousRootsWithFiles?: ReadonlySet<string>
  /** True once the pass is out of wall time; reads stop, everything else finishes. */
  overdue?: () => boolean
  /** One readdir per directory for the whole pass, shared by every step. */
  listings: SessionSearchDirectoryReader
  signal?: AbortSignal
}

export type SessionSearchPassResult = {
  /** Real roots this pass listed transcripts under, for the next pass to compare against. */
  rootsWithFiles: Set<string>
  degradedRoots: SessionSearchDegradedRoot[]
  /** False when the pass was cut short; its conclusions are not to be recorded. */
  completed: boolean
  /**
   * True when the deadline stopped the reads with candidates still owed.
   *
   * The caller's one use for it: a cycle lists the newest N per agent, so a
   * backlog outside that window is only *visible* to a sweep. Without this a
   * first run would index the recency window in its opening pass and then crawl,
   * making progress only on the periodic sweep every five minutes.
   */
  outOfTime: boolean
}

/**
 * One pass. Four steps, the same four whether it sweeps or cycles.
 *
 * 1. **Discover.** The only filesystem walk: every root on a sweep, the newest
 *    N per agent on a cycle. Everything below is decided from what it returns.
 * 2. **Decide and read.** Per candidate, its stat against its row. Reads stop
 *    at the deadline and nothing is recorded about what was left, because being
 *    owed is a fact about the row and not an entry in a queue.
 * 3. **Retire.** Candidates are the rows this pass's discovery did not return,
 *    inside the scope that discovery covered. The stateless walk proves each
 *    one gone, present or unverifiable; only `gone` deletes.
 * 4. **Report.** Root health for this pass. The counts are a query, made by the
 *    caller against the same rows, so nothing here is tallied.
 *
 * The pass keeps nothing. Everything it learns is either on a row or in the
 * result the caller compares against the next pass.
 */
export async function runSessionSearchPass(
  args: SessionSearchPassArgs
): Promise<SessionSearchPassResult> {
  const { store, signal } = args
  if (args.full) {
    // Every sweep opens with the purge, so a window narrower than the last
    // instance held is applied by the first sweep of this one.
    await store.purgeOlderThan(store.retentionCutoff, signal)
  }
  await ensureSessionParseCacheLoaded()
  return withCursorChatMetaScan(async () => {
    const swept = await discoverSessionSearchCandidates(args.roots, {
      limitPerAgent: args.full ? Number.POSITIVE_INFINITY : args.recentPerAgent,
      signal
    })
    const issues: AiVaultScanIssue[] = [...swept.issues]

    let completed = true
    let outOfTime = false
    const rows = new Map(store.files().map((row) => [row.path, row]))
    try {
      const read = await runSessionSearchIndexPass(store, swept.candidates, {
        signal,
        rows,
        overdue: args.overdue
      })
      outOfTime = read.outOfTime
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
    // Undefined, not empty, before any pass has recorded one: an empty set is a
    // real observation and this is the absence of one.
    const previousRootsWithFiles = args.previousRootsWithFiles
    // A pass cut short saw part of the machine, so its silence about a path is
    // not evidence; it retires nothing and publishes no verdicts.
    const retirement = completed
      ? await retireDeletedSessionSearchSources({
          store,
          paths: retirementCandidates(rows, swept, roots, args.full),
          roots,
          // Only a sweep enumerates without a per-agent limit, so only a sweep
          // may prove a synthetic row's container holds it no longer.
          enumeratedContainers: args.full
            ? sessionSearchEnumeratedContainers(swept.candidates, issues)
            : undefined,
          emptiedRoots: previousRootsWithFiles
            ? sessionSearchEmptiedRoots(previousRootsWithFiles, rootsWithFiles)
            : new Set(),
          listings: args.listings,
          limit: args.full ? RETIREMENT_CHECKS_PER_SWEEP : RETIREMENT_CHECKS_PER_CYCLE,
          signal
        })
      : { retired: [], unverifiable: [], unchecked: [], degradedRoots: [] }

    for (const refusal of cursorChatMetaRefusals()) {
      // One issue per refused chats root, not one per Cursor transcript.
      recordSessionScanIssue(issues, {
        agent: 'cursor',
        path: refusal.chatsRoot,
        message: refusal.message
      })
    }
    // Roots that listed no transcripts and cannot be listed either: the walker
    // swallows a readdir failure, so this is the only place it surfaces.
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
      outOfTime
    }
  })
}

/**
 * Rows this pass's discovery did not return, inside the scope it covered.
 *
 * A sweep covers everything, so every undiscovered row is a candidate. A cycle
 * covers the newest N per agent, so it may only judge rows under a root it
 * actually listed, and it takes the newest of those: an older row is not
 * evidence of anything a cycle looked for, and the next sweep is what reaches
 * it. This is the whole of what used to be a watch set carried between passes.
 */
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
    .slice(0, RETIREMENT_CHECKS_PER_CYCLE)
    .map((row) => row.path)
}
