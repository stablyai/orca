import { stepSessionSearchPublication } from './session-search-publication-step'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import type { SessionSearchStore } from './session-search-store'

export async function transitionSessionSearchCandidates(
  store: SessionSearchStore,
  command: SessionSearchCandidateCommand
): Promise<SessionSearchCandidateResult> {
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
    for (const row of command.rows) {
      store.catalogCandidates.execute({ kind: 'remove', ...row })
      const agent = store.fileRow(row.path)?.agent
      if (store.catalogCandidates.execute({ kind: 'path', path: row.path, agent }).rows.length) {
        continue
      }
      await store.work({ kind: 'remove', path: row.path })
      await store.catalog({
        kind: 'frontier-set',
        scope: 'retirement',
        key: row.path,
        value: JSON.stringify(row.path)
      })
    }
    return {
      ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }),
      work: await store.work({ kind: 'stats' })
    }
  }
  if (command.kind !== 'admit') {
    return store.catalogCandidates.execute(command)
  }
  for (const receipt of command.rows) {
    const row = store.catalogCandidates.entry(receipt.key)
    if (!row || row.revision !== receipt.revision) {
      continue
    }
    if (row.selected) {
      await store.work({
        kind: 'enqueue',
        candidate: row.candidate,
        force: command.recovering || row.forced,
        recent: command.recent,
        metadata: row.metadata
      })
    } else if (
      !store.catalogCandidates
        .execute({ kind: 'path', path: row.candidate.file.path })
        .rows.some((member) => member.selected)
    ) {
      await store.work({ kind: 'remove', path: row.candidate.file.path })
    }
    store.catalogCandidates.execute({
      kind: 'consumed',
      key: receipt.key,
      revision: receipt.revision
    })
  }
  const work = await store.work({ kind: 'stats' })
  return { ...store.catalogCandidates.execute({ kind: 'batch', rows: [] }), work }
}

export async function transitionSessionSearchWork(
  store: SessionSearchStore,
  queue: SessionSearchWorkCatalog,
  command: SessionSearchWorkCommand
): Promise<SessionSearchWorkResult> {
  queue.attach(store)
  let work
  switch (command.kind) {
    case 'enqueue':
      await queue.enqueue(command.candidate, store, command.force, command.recent, command.metadata)
      break
    case 'get':
      work = await queue.get(command.path)
      break
    case 'next':
      work = await queue.next()
      break
    case 'stats':
      break
    case 'acknowledge':
      await queue.acknowledge(command.work, command.retry)
      break
    case 'remove':
      await queue.remove(command.path)
      break
    case 'row':
      await queue.rowChanged(command.path, command.row)
      break
  }
  return { size: queue.size, left: queue.left, work }
}
