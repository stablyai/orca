import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type {
  SessionSearchCandidateRow,
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import { requireSessionSearchCandidateReason } from './session-search-candidate-reason'
import type { SessionSearchFactReference } from './session-search-candidate-facts'
import {
  projectSessionSearchWorkAdmission,
  projectSessionSearchAdmissionMetadata,
  sessionSearchProjectedCursor
} from './session-search-work-admission'
import { sessionSearchReadDecision } from './indexing/session-search-read-decision'

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
  current?: SessionSearchCandidateRow[],
  references?: Map<string, SessionSearchFactReference>
): SessionSearchCandidateResult {
  const changedPaths = new Set<string>()
  let position = 0
  const scopeCounts: [string, number, number][] = []
  const paths = current?.map((row) => row.candidate.file.path)
  const projected = paths && projectSessionSearchWorkAdmission(store.connection, paths)
  const metadata = paths && projectSessionSearchAdmissionMetadata(store.connection, paths)
  const repeated = new Set(paths?.filter((path, index) => paths.indexOf(path) !== index))
  let inserted: Parameters<SessionSearchWorkCatalog['insertAccepted']>[0] = []
  const flush = () => {
    queue.insertAccepted(inserted, command.recent)
    inserted = []
  }
  const consumed: { key: string; revision: number }[] = []
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
      const path = row.candidate.file.path
      const debt = metadata
        ? metadata.get(path)
        : store.catalogStorage.execute({
            kind: 'get',
            scope: 'discovery-metadata',
            key: row.candidate.file.path
          }).rows?.[0]
      if (debt) {
        flush()
        requireSessionSearchCandidateReason(store, row.candidate.file.path, 'metadata')
        changedPaths.add(row.candidate.file.path)
        row = store.catalogCandidates.entry(receipt.key)!
        const accepted = store.catalogStorage.response({
          kind: 'ack-values',
          scope: 'discovery-metadata',
          rows: [{ key: debt.key, value: debt.value }]
        })
        scopeCounts.push(...(accepted.scopeCounts ?? []))
        metadata?.delete(path)
        projected?.delete(path)
      }
      changedPaths.add(row.candidate.file.path)
      const projection = projected?.get(path)
      const reference = references?.get(row.key)
      const force = command.recovering || row.forced
      if (
        projection &&
        reference &&
        !projection.work &&
        !force &&
        !repeated.has(path) &&
        projection.file?.state !== 'failed'
      ) {
        const decision = sessionSearchReadDecision({
          candidate: row.candidate,
          row: projection.file,
          cursor: sessionSearchProjectedCursor(row.candidate, projection.file),
          cutoffMs: store.retentionCutoff
        })
        if (row.metadata || decision !== 'skip') {
          inserted.push({
            candidate: row.candidate,
            reference,
            due: projection.file?.state === 'due',
            metadata: row.metadata
          })
        }
      } else {
        flush()
        queue.enqueue(
          row.candidate,
          store,
          force,
          command.recent,
          row.metadata,
          projection ? { projection, reference } : undefined
        )
      }
      projected?.delete(path)
    } else if (!row.protectedPath) {
      flush()
      queue.removeAccepted(row.candidate.file.path)
      projected?.delete(row.candidate.file.path)
    }
    consumed.push({ key: receipt.key, revision: row.revision })
  }
  flush()
  store.catalogCandidates.consumedPage(consumed)
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
