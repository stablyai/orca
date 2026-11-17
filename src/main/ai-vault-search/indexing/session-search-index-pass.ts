import { throwIfAiVaultScanCancelled } from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import { isTranscriptSourceFailure } from '../../ai-vault/parsing/session-scanner-jsonl-reader'
import {
  physicalSessionCandidates,
  type SessionFileChoice
} from '../../ai-vault/session-scanner-types'
import { fileIdentity } from '../storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type {
  SessionSearchFileRow,
  SessionSearchIndexStore
} from '../storage/session-search-store-types'

export type SessionSearchIndexPassOptions = {
  signal?: AbortSignal
  /** Snapshot of indexed rows; a missing key means the path has no row. */
  rows: ReadonlyMap<string, SessionSearchFileRow>
  /** Stop between files once overdue, but always read one file to avoid starving large transcripts. */
  overdue?: () => boolean
}

/** Deferred candidates stay owed by their stored state; left counts backlog outside the due-row count. */
export async function runSessionSearchIndexPass(
  store: SessionSearchIndexStore,
  candidates: readonly SessionFileChoice[],
  options: SessionSearchIndexPassOptions
): Promise<{ stats: SessionParseStats; outOfTime: boolean; left: number }> {
  const stats = createSessionParseStats()
  const cutoffMs = store.retentionCutoff
  const acceptsReads = () => store.acceptingReads !== false
  let read = 0
  let outOfTime = false
  let left = 0
  for (const choice of candidates) {
    throwIfAiVaultScanCancelled(options.signal)
    if (!acceptsReads()) {
      break
    }
    let deferred = false
    let due = false
    let admitted = false
    for (const candidate of physicalSessionCandidates(choice)) {
      throwIfAiVaultScanCancelled(options.signal)
      if (!acceptsReads()) {
        break
      }
      const path = candidate.file.path
      const row = options.rows.get(path)
      const cursor = row ? store.indexedFile(path, fileIdentity(candidate.file)) : null
      const decision = sessionSearchReadDecision({ candidate, row, cursor, cutoffMs })
      if (decision === 'skip') {
        if (
          (cutoffMs === null || candidate.file.mtimeMs >= cutoffMs) &&
          row?.state === 'current' &&
          cursor !== null
        ) {
          deferred = false
          break
        }
        continue
      }
      if (!admitted) {
        outOfTime ||= read > 0 && options.overdue?.() === true
      }
      if (outOfTime && !admitted) {
        deferred = true
        due ||= row?.state === 'due'
        continue
      }
      throwIfAiVaultScanCancelled(options.signal)
      if (!acceptsReads()) {
        break
      }
      admitted = true
      read += 1
      try {
        await parseAgentSessionFileCached(
          candidate,
          process.platform,
          stats,
          decision,
          options.signal,
          true
        )
      } catch (error) {
        throwIfAiVaultScanCancelled(options.signal)
        console.warn(
          '[ai-vault-search] indexing skipped',
          candidate.agent,
          error instanceof Error ? error.name : 'ParseError'
        )
        if (isTranscriptSourceFailure(error)) {
          continue
        }
        break
      }
      // Consumer/store failures cannot authorize reading another physical alias.
      try {
        await store.flush?.()
      } catch (error) {
        throwIfAiVaultScanCancelled(options.signal)
        console.warn(
          '[ai-vault-search] indexing skipped',
          candidate.agent,
          error instanceof Error ? error.name : 'FlushError'
        )
      }
      break
    }
    if (deferred && !due) {
      left += 1
    }
  }
  return { stats, outOfTime, left }
}
