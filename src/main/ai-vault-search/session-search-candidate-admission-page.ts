import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type {
  SessionSearchCandidateRow,
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import { requireSessionSearchCandidateReason } from './session-search-candidate-reason'

/** Known successor work and its exact delivery receipt accept together, before the actual read. */
export function admitSessionSearchCandidatePage(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: Extract<SessionSearchCandidateCommand, { kind: 'admit' }>
): SessionSearchCandidateResult {
  return store.catalogStorage.transaction('search_candidate_admit', () =>
    acceptSessionSearchCandidatePage(store, queue, command)
  )
}

export function acceptSessionSearchCandidatePage(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: Extract<SessionSearchCandidateCommand, { kind: 'admit' }>,
  current?: SessionSearchCandidateRow[]
): SessionSearchCandidateResult {
  const changedPaths = new Set<string>()
  let position = 0
  const scopeCounts: [string, number, number][] = []
  for (const receipt of command.rows) {
    const known = current?.[position++]
    let row =
      known && !changedPaths.has(known.candidate.file.path)
        ? known
        : store.catalogCandidates.entry(receipt.key)
    if (!row || row.revision !== receipt.revision) {
      continue
    }
    if (row.selected) {
      const debt = store.catalogStorage.execute({
        kind: 'get',
        scope: 'discovery-metadata',
        key: row.candidate.file.path
      }).rows?.[0]
      if (debt) {
        requireSessionSearchCandidateReason(store, row.candidate.file.path, 'metadata')
        changedPaths.add(row.candidate.file.path)
        row = store.catalogCandidates.entry(receipt.key)!
        const accepted = store.catalogStorage.response({
          kind: 'ack-values',
          scope: 'discovery-metadata',
          rows: [{ key: debt.key, value: debt.value }]
        })
        scopeCounts.push(...(accepted.scopeCounts ?? []))
      }
      changedPaths.add(row.candidate.file.path)
      queue.enqueue(
        row.candidate,
        store,
        command.recovering || row.forced,
        command.recent,
        row.metadata
      )
    } else if (!row.protectedPath) {
      queue.removeAccepted(row.candidate.file.path)
    }
    store.catalogCandidates.execute({
      kind: 'consumed',
      key: receipt.key,
      revision: row.revision
    })
  }
  const delivery = command.read?.delivery
  if (delivery) {
    const accepted = store.catalogStorage.response({
      kind: 'observe-ack',
      scope: delivery.scope,
      receipts: [{ path: delivery.path, revision: delivery.revision }]
    })
    scopeCounts.push(...(accepted.scopeCounts ?? []))
  }
  return {
    ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }),
    scopeCounts,
    work: {
      size: queue.size,
      left: queue.left,
      revision: queue.revision,
      work: command.read ? queue.get(command.read.path) : undefined
    }
  }
}
