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
  /** Snapshot of indexed rows; a missing key means the path has no row. */
  rows: ReadonlyMap<string, SessionSearchFileRow>
  /** Stop between files once overdue, but always read one file to avoid starving large transcripts. */
  overdue?: () => boolean
}

/** Deferred candidates stay owed by their stored state; left counts backlog outside the due-row count. */
export async function runSessionSearchIndexPass(
  store: SessionSearchStore,
  candidates: readonly SessionFileCandidate[],
  options: SessionSearchIndexPassOptions
): Promise<{ stats: SessionParseStats; outOfTime: boolean; left: number }> {
  const stats = createSessionParseStats()
  const cutoffMs = store.retentionCutoff
  let read = 0
  let outOfTime = false
  let left = 0
  for (const candidate of candidates) {
    throwIfAiVaultScanCancelled(options.signal)
    const path = candidate.file.path
    const row = options.rows.get(path)
    const decision = sessionSearchReadDecision({
      candidate,
      row,
      // New paths already require reading; avoid a redundant cursor query per file.
      cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
      cutoffMs
    })
    if (decision === 'skip') {
      continue
    }
    // Continue decisions after the read deadline to count remaining backlog.
    outOfTime ||= read > 0 && options.overdue?.() === true
    if (outOfTime) {
      // Status adds left to due-row counts; exclude due rows here to avoid double counting.
      if (row?.state !== 'due') {
        left += 1
      }
      continue
    }
    // Deadline callbacks may close the owner; recheck cancellation before touching the store.
    throwIfAiVaultScanCancelled(options.signal)
    read += 1
    try {
      await parseAgentSessionFileCached(
        candidate,
        process.platform,
        stats,
        decision,
        options.signal
      )
    } catch (error) {
      throwIfAiVaultScanCancelled(options.signal)
      console.warn(
        '[ai-vault-search] indexing skipped',
        candidate.agent,
        error instanceof Error ? error.name : 'ParseError'
      )
    }
  }
  return { stats, outOfTime, left }
}
