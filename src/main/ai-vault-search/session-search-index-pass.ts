import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
import {
  createSessionParseStats,
  invalidateSessionParseCacheEntry,
  parseAgentSessionFileCached,
  sessionParseCacheCoversTranscript,
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
    const forced = mustReadWhole(store, candidate, options.forced)
    if (!indexable(store, candidate, forced)) {
      continue
    }
    const bytes = forced ? (candidate.file.sizeBytes ?? 0) : unreadBytes(store, candidate)
    if (options.allowance && !options.allowance.spend(bytes)) {
      deferred.push(...candidates.slice(index))
      break
    }
    // Two reasons to drop the session list's cursor, both of which end with
    // the reader opening the file: the index has to re-read it whole, or the
    // list is already done with it and would otherwise read nothing at all.
    // The second is not an edge case: any file the list scanned before the
    // index existed is in exactly that state.
    if (forced || sessionParseCacheCoversTranscript(candidate, process.platform)) {
      invalidateSessionParseCacheEntry(candidate.file.path)
    }
    try {
      await parseAgentSessionFileCached(candidate, process.platform, stats)
      options.onIndexed?.(candidate, bytes)
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

function indexable(
  store: SessionSearchStore,
  candidate: SessionFileCandidate,
  forced: boolean
): boolean {
  if (!store.acceptsCandidate(candidate)) {
    return false
  }
  // A parser that decodes where the message channel cannot reach it can never
  // extend the index, so reading it here would be pure cost.
  if (!parserPublishesMessages(candidate)) {
    return false
  }
  if (forced) {
    return true
  }
  return !isSessionSearchFileCurrent(
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
