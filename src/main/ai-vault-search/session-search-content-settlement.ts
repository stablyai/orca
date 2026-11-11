import { readSessionSearchSnapshotRows } from './session-search-snapshot-rows'
import {
  sessionSearchReadDecision,
  SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT
} from './indexing/session-search-read-decision'
import { fileIdentity } from './storage/session-search-file-cursor'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchFileRow } from './storage/session-search-store-types'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type { SessionSearchFileWrite } from './storage/session-search-index-writer'
import type {
  SessionSearchReadContext,
  SessionSearchWorkCommand,
  SessionSearchWorkReceipt
} from './session-search-work-queue'

export function settleSessionSearchContent(
  store: SessionSearchStore,
  candidate: SessionFileCandidate,
  reason: string,
  metadataOnly: boolean,
  receipt?: SessionSearchWorkReceipt
) {
  const queue = store.catalogWork
  const candidates = store.catalogCandidates
  const catalog = store.catalogStorage
  return catalog.transaction('search_content_settlement', () => {
    const path = candidate.file.path
    candidates.acknowledge(path, candidate.agent, reason, metadataOnly, false)
    store.settleAcceptedFile(path)
    const row = readSessionSearchSnapshotRows(store, path)[0]
    const admission = candidates.admission(candidate)
    if (receipt) {
      const retry =
        sessionSearchReadDecision({
          candidate,
          row,
          cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
          cutoffMs: store.retentionCutoff
        }) !== 'skip'
      applySessionSearchWorkAcknowledgement(
        store,
        queue,
        {
          kind: 'acknowledge',
          work: {
            candidate,
            force: receipt.force,
            metadata: receipt.metadata,
            version: receipt.version,
            receipt
          },
          retry,
          reconcile: true
        },
        { row, admission }
      )
    }
    candidates.rowChanged(path)
    return { row, work: { size: queue.size, left: queue.left, revision: queue.revision } }
  })
}

export function invalidateSessionSearchAcceptedContent(
  store: SessionSearchStore,
  path: string
): void {
  try {
    const candidates = store.catalogCandidates
    const catalog = store.catalogStorage
    catalog.transaction('search_content_invalidation', () => candidates.rowChanged(path))
  } catch {
    // Accepted content must not become a source failure when bookkeeping is unavailable.
  }
}

export function bindSessionSearchReadSettlement(
  write: SessionSearchFileWrite,
  read: SessionSearchReadContext,
  settle: () => ReturnType<typeof settleSessionSearchContent> | undefined,
  rejected: () => void
): SessionSearchFileWrite {
  return {
    ...write,
    commit: (outcome) => {
      const accepted = write.commit(outcome)
      if (accepted) {
        try {
          const result = settle()
          if (result) {
            read.settlement = Promise.resolve({ disposition: 'settled', work: result.work })
          }
        } catch {
          read.settlement = Promise.resolve({ disposition: 'content-accepted/settlement-rejected' })
          rejected()
        }
      }
      return accepted
    }
  }
}

export function applySessionSearchWorkAcknowledgement(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: Extract<SessionSearchWorkCommand, { kind: 'acknowledge' }>,
  known?: {
    row: SessionSearchFileRow | undefined
    admission: ReturnType<SessionSearchStore['catalogCandidates']['admission']>
  }
): boolean {
  return queue.acknowledgeCurrent(command.work, () => {
    const row = known ? known.row : store.fileRow(command.work.candidate.file.path)
    const admission = known
      ? known.admission
      : store.catalogCandidates.admission(command.work.candidate)
    const required = admission.contentRequired
    const handoff = command.handoff
    const refusal = handoff?.scope.startsWith(`physical:${command.work.candidate.agent}:`)
      ? store.catalogStorage.execute({
          kind: 'get',
          scope: `${handoff.scope}:file-refusals`,
          key: command.work.candidate.file.path
        }).rows?.[0]
      : undefined
    const debt: { force?: boolean; metadata?: boolean } | undefined = refusal
      ? JSON.parse(refusal.value)
      : undefined
    const transferred =
      handoff &&
      refusal?.tie === handoff.revision &&
      (!required || debt?.force) &&
      (!command.work.metadata || debt?.metadata)
    const held =
      row?.state === 'failed' &&
      row.failCount >= SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT &&
      row.failedMtimeMs === command.work.candidate.file.mtimeMs
    const expired =
      store.retentionCutoff !== null && command.work.candidate.file.mtimeMs < store.retentionCutoff
    return {
      force: required || (command.work.force && command.retry),
      retry:
        transferred || !admission.allowed
          ? false
          : command.handoff
            ? admission.required
            : required
              ? !held && !expired
              : command.retry,
      due: command.reconcile && row?.state === 'due'
    }
  })
}
