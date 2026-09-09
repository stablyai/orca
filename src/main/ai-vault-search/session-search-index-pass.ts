import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../ai-vault/session-scanner-parse-cache'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity, isSessionSearchFileCurrent } from './session-search-file-cursor'
import type { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import type { SessionSearchStore } from './session-search-store'

export type SessionSearchIndexPassOptions = {
  signal?: AbortSignal
  /** Cycle allowance; work that does not fit comes back as `deferred`. */
  allowance?: SessionSearchCycleAllowance
  /** Paths whose stored cursor must not be trusted, so the read is forced whole. */
  forced?: ReadonlySet<string>
  /** Sleeps between batches so an unasked backfill never owns the CPU. */
  pace?: (signal?: AbortSignal) => Promise<void>
  onIndexed?: (candidate: SessionFileCandidate, bytes: number) => void
  /** The index already covers this file, or can never index it; nothing is owed. */
  onSkipped?: (candidate: SessionFileCandidate) => void
  onFailed?: (candidate: SessionFileCandidate) => void
}

export type SessionSearchIndexPassResult = {
  stats: SessionParseStats
  /** Candidates the allowance had no room for, in the order they were queued. */
  deferred: SessionFileCandidate[]
}

const FILES_PER_PACE = 8

/**
 * Reads a candidate list through the transcript reader so the registered index
 * consumer folds it. Candidates the index already covers at their current stat
 * are skipped outright, which is what makes a restart resume: the `files` table
 * survives the process, so a second start re-reads nothing it already holds.
 */
export async function runSessionSearchIndexPass(
  store: SessionSearchStore,
  candidates: readonly SessionFileCandidate[],
  options: SessionSearchIndexPassOptions = {}
): Promise<SessionSearchIndexPassResult> {
  const stats = createSessionParseStats()
  const deferred: SessionFileCandidate[] = []
  let sincePace = 0
  for (const [index, candidate] of candidates.entries()) {
    throwIfAiVaultScanCancelled(options.signal)
    // Ask the store whether it wants this candidate at all before reading its
    // cursor: a closed or paused store answers no, and every read after that
    // would be against a handle it has already given up.
    if (!wantsCandidate(store, candidate)) {
      options.onSkipped?.(candidate)
      continue
    }
    const forced = mustReadWhole(store, candidate, options.forced)
    if (!forced && indexIsCurrent(store, candidate)) {
      options.onSkipped?.(candidate)
      continue
    }
    const bytes = forced ? (candidate.file.sizeBytes ?? 0) : unreadBytes(store, candidate)
    if (options.allowance && !options.allowance.spend(bytes)) {
      deferred.push(...candidates.slice(index))
      break
    }
    // `whole` for a path the store handed back from `takeStale` or a caller
    // invalidated: the reader would otherwise pick `append` from the session
    // list's resume point and the consumer would decline it again, every cycle,
    // forever. `any` for the rest, because reaching here means the index is
    // behind, and a list cursor already at this file's current stat would make
    // the parse open nothing at all — the state every transcript is in the
    // first time the index is switched on inside a running app.
    try {
      await parseAgentSessionFileCached(
        candidate,
        process.platform,
        stats,
        forced ? 'whole' : 'any'
      )
      // Took it, not moved: the test is whether the index now covers this file
      // at this stat, which is the same question the skip at the top asks. A
      // cursor comparison looks equivalent and is not — a forced re-read of an
      // unchanged file writes an identical cursor, so it would never settle and
      // the path would be re-read whole every interval for good.
      if (indexIsCurrent(store, candidate)) {
        options.onIndexed?.(candidate, bytes)
      }
    } catch (error) {
      throwIfAiVaultScanCancelled(options.signal)
      options.onFailed?.(candidate)
      console.warn(
        '[ai-vault-search] indexing skipped',
        candidate.agent,
        error instanceof Error ? error.name : 'ParseError'
      )
    }
    if (++sincePace >= FILES_PER_PACE) {
      sincePace = 0
      await options.pace?.(options.signal)
    }
  }
  return { stats, deferred }
}

function wantsCandidate(store: SessionSearchStore, candidate: SessionFileCandidate): boolean {
  // A parser that decodes where the message channel cannot reach it can never
  // extend the index, so reading it here would be pure cost.
  return store.acceptsCandidate(candidate) && parserPublishesMessages(candidate)
}

function indexIsCurrent(store: SessionSearchStore, candidate: SessionFileCandidate): boolean {
  return isSessionSearchFileCurrent(
    store.indexedFile(candidate.file.path, fileIdentity(candidate.file)),
    candidate.file
  )
}

/**
 * True when the rows under this path describe a file that no longer exists:
 * the same name now carries a different dev/ino, or it is shorter than the
 * offset the index read to. Either way an append would splice two files
 * together, so the read has to start over.
 */
function mustReadWhole(
  store: SessionSearchStore,
  candidate: SessionFileCandidate,
  forced?: ReadonlySet<string>
): boolean {
  if (forced?.has(candidate.file.path)) {
    return true
  }
  const stored = store.indexedFile(candidate.file.path, null)
  if (!stored) {
    return false
  }
  if (!store.indexedFile(candidate.file.path, fileIdentity(candidate.file))) {
    return true
  }
  const size = candidate.file.sizeBytes
  return typeof size === 'number' && stored.byteOffset > size
}

/** What this read will actually cost: the tail past the index's own cursor. */
function unreadBytes(store: SessionSearchStore, candidate: SessionFileCandidate): number {
  const size = candidate.file.sizeBytes ?? 0
  const indexed = store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
  if (!indexed || indexed.byteOffset > size) {
    return size
  }
  return size - indexed.byteOffset
}
