import { applySessionSearchWorkAcknowledgement } from './session-search-store-transitions'
import { readSessionSearchSnapshotRows } from './session-search-snapshot-rows'
import { sessionSearchReadDecision } from './indexing/session-search-read-decision'
import { fileIdentity } from './storage/session-search-file-cursor'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchFileWrite } from './storage/session-search-index-writer'
import type {
  SessionSearchReadContext,
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
