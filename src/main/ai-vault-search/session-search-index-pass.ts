import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../ai-vault/session-scanner-parse-cache'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type { SessionSearchFileRow, SessionSearchStore } from './session-search-store'

export type SessionSearchIndexPassOptions = {
  signal?: AbortSignal
  /** The store's rows for this pass, read once. Absent means the index holds nothing. */
  rows: ReadonlyMap<string, SessionSearchFileRow>
  /**
   * True once the pass has spent its wall-clock deadline. The one bound on how
   * long a pass reads for: files and bytes are proxies for time, and the thing
   * worth capping is the share of the wall clock an unasked background index
   * takes. Never applied before the pass has read anything, so an oversized
   * transcript is read alone rather than deferred for ever.
   */
  overdue?: () => boolean
}

/**
 * Reads whatever the decide step says is owed, until the deadline.
 *
 * Nothing is recorded about what it did not reach. A candidate the deadline cut
 * off is still owed on the next pass for the same reason it was owed on this
 * one — its row says so — so there is no queue to keep, nothing to bound, and
 * nothing to drop. What the reads themselves leave behind is written by the
 * index consumer onto the rows.
 */
export async function runSessionSearchIndexPass(
  store: SessionSearchStore,
  candidates: readonly SessionFileCandidate[],
  options: SessionSearchIndexPassOptions
): Promise<{ stats: SessionParseStats; outOfTime: boolean }> {
  const stats = createSessionParseStats()
  const cutoffMs = store.retentionCutoff
  let read = 0
  let outOfTime = false
  for (const candidate of candidates) {
    throwIfAiVaultScanCancelled(options.signal)
    const path = candidate.file.path
    const row = options.rows.get(path)
    const decision = sessionSearchReadDecision({
      candidate,
      row,
      // Only asked for a path the index holds something for; for the rest the
      // decision is already made and this would be a query per new file.
      cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
      cutoffMs
    })
    if (decision === 'skip') {
      continue
    }
    // The decide step is one cursor lookup, so it runs for the whole list even
    // once the deadline has gone: knowing what is owed costs nothing, and the
    // count of what a pass left is worth more than the microseconds.
    outOfTime ||= read > 0 && options.overdue?.() === true
    if (outOfTime) {
      continue
    }
    // The clock the deadline reads is one the owner may close behind: the read
    // below writes to the store, so stop here rather than on a shut handle.
    throwIfAiVaultScanCancelled(options.signal)
    read += 1
    try {
      await parseAgentSessionFileCached(candidate, process.platform, stats, decision)
    } catch (error) {
      throwIfAiVaultScanCancelled(options.signal)
      // The reader reports a read it could not finish to the consumer, which is
      // what records the failure on the row; nothing is counted here.
      console.warn(
        '[ai-vault-search] indexing skipped',
        candidate.agent,
        error instanceof Error ? error.name : 'ParseError'
      )
    }
  }
  return { stats, outOfTime }
}
