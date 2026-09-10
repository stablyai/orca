import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../ai-vault/session-scanner-parse-cache'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity, isSessionSearchFileCurrent } from './session-search-file-cursor'
import type { SessionSearchStore } from './session-search-store'

export type SessionSearchIndexPassOptions = {
  signal?: AbortSignal
  /**
   * True once the pass has spent its wall-clock deadline. The one bound on how
   * long a pass reads for: files and bytes are proxies for time, and the thing
   * worth capping is the share of the wall clock an unasked background index
   * takes. Never applied before the pass has read anything, so an oversized
   * transcript is read alone rather than deferred for ever.
   */
  overdue?: () => boolean
  /** Paths whose stored cursor must not be trusted, so the read is forced whole. */
  forced?: ReadonlySet<string>
  /** True for a file that has failed at this stat often enough to stop trying. */
  heldOut?: (candidate: SessionFileCandidate) => boolean
  onIndexed?: (candidate: SessionFileCandidate, bytes: number) => void
  /** The index already covers this file, or can never index it; nothing is owed. */
  onSkipped?: (candidate: SessionFileCandidate) => void
  onFailed?: (candidate: SessionFileCandidate) => void
}

export type SessionSearchIndexPassResult = {
  stats: SessionParseStats
  /** Candidates the deadline left unread, in the order they were queued. */
  deferred: SessionFileCandidate[]
}

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
  let read = 0
  let outOfTime = false
  for (const candidate of candidates) {
    throwIfAiVaultScanCancelled(options.signal)
    // Ask the store whether it wants this candidate at all before reading its
    // cursor: a closed store answers no, and every read after that would be
    // against a handle it has already given up.
    if (!wantsCandidate(store, candidate)) {
      options.onSkipped?.(candidate)
      continue
    }
    // Skipped rather than read: a read is what re-records the file as owed, so
    // holding it out has to happen before one, not after.
    if (options.heldOut?.(candidate) === true) {
      options.onSkipped?.(candidate)
      continue
    }
    const forced = mustReadWhole(store, candidate, options.forced)
    if (!forced && indexIsCurrent(store, candidate)) {
      options.onSkipped?.(candidate)
      continue
    }
    // The skip checks above run for the whole list even once the deadline has
    // gone, because they are one cursor lookup each and deferring a file the
    // index already covers would buy it a whole re-read it does not need.
    outOfTime ||= read > 0 && options.overdue?.() === true
    if (outOfTime) {
      deferred.push(candidate)
      continue
    }
    // The deadline check reads a clock the owner may close behind: everything
    // below touches the store, so stop here rather than on a shut handle.
    throwIfAiVaultScanCancelled(options.signal)
    read += 1
    // Discovery's size, not the post-read one. A file that grew between the
    // stat and the read is reported short, deliberately: re-statting every file
    // to close the gap would cost more than the number is worth.
    const bytes = forced ? (candidate.file.sizeBytes ?? 0) : unreadBytes(store, candidate)
    // `whole` for a path the store handed back from `takeStale`: the reader
    // would otherwise pick `append` from the session list's resume point and the
    // consumer would decline it again, every cycle, forever. `any` for the rest,
    // because reaching here means the index is behind, and a list cursor already
    // at this file's current stat would make the parse open nothing at all --
    // the state every transcript is in the first time the index is switched on
    // inside a running app.
    try {
      await parseAgentSessionFileCached(
        candidate,
        process.platform,
        stats,
        forced ? 'whole' : 'any'
      )
      // Closing during a read aborts it, and every line below reads the store.
      throwIfAiVaultScanCancelled(options.signal)
      // Took it, not moved: the test is whether the index now covers this file
      // at this stat, which is the same question the skip at the top asks. A
      // cursor comparison looks equivalent and is not -- a forced re-read of an
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
 * True when an append would splice this read onto rows it does not continue:
 * the same name now carries a different dev/ino, the file is shorter than the
 * offset the index read to, or a chunked read left a prefix and no cursor at
 * all. Either way the read has to start over.
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
  const offset = stored.byteOffset
  if (offset === null) {
    // A read that died between chunks. Asking for an append here is a read the
    // consumer declines, so the repair would wait a whole extra pass.
    return true
  }
  const size = candidate.file.sizeBytes
  return typeof size === 'number' && offset > size
}

/** What this read will actually cost: the tail past the index's own cursor. */
function unreadBytes(store: SessionSearchStore, candidate: SessionFileCandidate): number {
  const size = candidate.file.sizeBytes ?? 0
  const indexed = store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
  // No cursor to read past: a half-written file starts over, so it costs all of it.
  const offset = indexed?.byteOffset ?? null
  return offset === null || offset > size ? size : size - offset
}
