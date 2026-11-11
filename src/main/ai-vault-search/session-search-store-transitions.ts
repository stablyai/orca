export { requireSessionSearchCandidateReason } from './session-search-candidate-reason'
import { acceptSessionSearchDiscoveryPage } from './session-search-discovery-acceptance'
import { prepareSessionSearchRead } from './session-search-read-preparation'
import { admitSessionSearchCandidatePage } from './session-search-candidate-admission-page'
import { validSessionSearchContainerRemoval } from './session-search-container-transition'
import { applySessionSearchWorkAcknowledgement } from './session-search-content-settlement'
import { stepSessionSearchPublication } from './session-search-publication-step'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import type { SessionSearchStore } from './storage/session-search-store'

export async function transitionSessionSearchCandidates(
  store: SessionSearchStore,
  command: SessionSearchCandidateCommand
): Promise<SessionSearchCandidateResult> {
  if (command.kind === 'path' && command.read && typeof command.read !== 'boolean') {
    return prepareSessionSearchRead(store, command.path, command.agent, command.read)
  }
  if (command.kind === 'batch' && command.admission) {
    return acceptSessionSearchDiscoveryPage(store, command)
  }
  if (command.kind === 'publication-step') {
    const publication = await stepSessionSearchPublication(store)
    return { ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }), ...publication }
  }
  if (command.kind === 'unowned-page') {
    return {
      ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }),
      unowned: command.rows
        .filter(
          (row) =>
            !(row.agent
              ? store.connection
                  .prepare('SELECT 1 FROM temp.search_candidates WHERE path=? AND agent=? LIMIT 1')
                  .get(row.path, row.agent)
              : store.connection
                  .prepare('SELECT 1 FROM temp.search_candidates WHERE path=? LIMIT 1')
                  .get(row.path))
        )
        .map((row) => row.path)
    }
  }
  if (command.kind === 'remove-page') {
    store.catalogStorage.transaction('search_candidate_remove', () => {
      for (const row of command.rows) {
        if (row.observation && !store.validRemoval(row.path, row.observation)) {
          continue
        }
        const receipts = row.containers?.filter((receipt) =>
          validSessionSearchContainerRemoval(store.catalogStorage, row.path, receipt)
        )
        const agents = receipts
          ? row.agents?.filter((agent) => receipts.some((receipt) => receipt.agent === agent))
          : row.agents
        if (receipts && (!receipts.length || !agents?.length)) {
          continue
        }
        store.catalogCandidates.execute({ kind: 'remove', path: row.path, agents })
        const agent = store.fileRow(row.path)?.agent
        if (!store.catalogCandidates.execute({ kind: 'path', path: row.path, agent }).rows.length) {
          store.removeReadWork(row.path)
          store.catalogStorage.execute({
            kind: 'frontier-set',
            scope: 'retirement',
            key: row.path,
            value: JSON.stringify(row.path)
          })
        }
        for (const receipt of receipts ?? []) {
          store.catalogStorage.execute({
            kind: 'delete',
            scope: `${receipt.scope}:omissions`,
            key: row.path
          })
        }
      }
    })
    return {
      ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }),
      work: await store.work({ kind: 'stats' })
    }
  }
  if (command.kind !== 'admit') {
    const result = store.catalogCandidates.execute(command)
    if (command.kind === 'path' && command.read) {
      return { ...result, work: await store.work({ kind: 'get', path: command.path }) }
    }
    return result
  }
  return admitSessionSearchCandidatePage(store, store.catalogWork, command)
}

export async function transitionSessionSearchWork(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: SessionSearchWorkCommand
): Promise<SessionSearchWorkResult> {
  let work
  let works
  let eligibleThrough
  switch (command.kind) {
    case 'enqueue':
      queue.enqueue(command.candidate, store, command.force, command.recent, command.metadata)
      break
    case 'get':
      work = queue.get(command.path)
      break
    case 'next':
      eligibleThrough = command.eligibleThrough ?? queue.eligibleThrough
      works = queue.next(eligibleThrough)
      break
    case 'stats':
      break
    case 'acknowledge':
      acknowledgeSessionSearchWork(store, queue, command)
      break
    case 'remove':
      await queue.remove(command.path)
      break
    case 'row':
      await queue.rowChanged(command.path, command.row)
      break
  }
  return {
    size: queue.size,
    left: queue.left,
    work,
    works,
    eligibleThrough,
    revision: queue.revision
  }
}

export function acknowledgeSessionSearchWork(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: Extract<SessionSearchWorkCommand, { kind: 'acknowledge' }>
): void {
  const candidates = store.catalogCandidates
  const catalog = store.catalogStorage
  catalog.transaction('search_work_settlement', () => {
    if (applySessionSearchWorkAcknowledgement(store, queue, command)) {
      candidates.rowChanged(command.work.candidate.file.path)
    }
  })
}
