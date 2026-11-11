import { SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT } from './session-search-read-decision'
import { recordSessionSearchPrimaryFailure } from './session-search-primary-retries'
import { wakeSessionSearchMetadataWrite } from './session-search-store-write'
import { stepSessionSearchPublication } from './session-search-publication-step'
import type { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import type { SessionSearchStore } from './session-search-store'

function wakeFailedFile(store: SessionSearchStore, path: string): void {
  const previous = store.fileRow(path)
  if (previous?.state !== 'failed') {
    return
  }
  store.setFileState(path, 'current')
  const row = store.fileRow(path)
  if (row) {
    store.onSourceWake(previous, row)
  }
}

export function requireSessionSearchCandidateReason(
  store: SessionSearchStore,
  path: string,
  reason: 'force' | 'metadata'
): boolean {
  const selected = store.catalogCandidates
    .execute({ kind: 'path', path })
    .rows.some((row) => row.selected)
  if (selected) {
    if (
      reason === 'metadata' &&
      wakeSessionSearchMetadataWrite(store.connection, path, store.fileRow(path))
    ) {
      wakeFailedFile(store, path)
    }
    if (reason === 'force' && store.fileRow(path)?.state === 'failed') {
      wakeFailedFile(store, path)
    }
    store.catalogCandidates.execute({ kind: 'require', path, reason, delivered: true })
  }
  return selected
}

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
      if (row.observation && !store.validRemoval(row.path, row.observation)) {
        continue
      }
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
    const result = store.catalogCandidates.execute(command)
    if (command.kind === 'path' && command.read) {
      return { ...result, work: await store.work({ kind: 'get', path: command.path }) }
    }
    return result
  }
  for (const receipt of command.rows) {
    let row = store.catalogCandidates.entry(receipt.key)
    if (!row || row.revision !== receipt.revision) {
      continue
    }
    if (row.selected) {
      const debt = (
        await store.catalog({
          kind: 'get',
          scope: 'discovery-metadata',
          key: row.candidate.file.path
        })
      ).rows?.[0]
      if (debt) {
        requireSessionSearchCandidateReason(store, row.candidate.file.path, 'metadata')
        row = store.catalogCandidates.entry(receipt.key)!
        await store.catalog({
          kind: 'ack-values',
          scope: 'discovery-metadata',
          rows: [{ key: debt.key, value: debt.value }]
        })
      }
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
      revision: row.revision
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
  let works
  let eligibleThrough
  switch (command.kind) {
    case 'enqueue':
      if (store.fileRow(command.candidate.file.path)?.state === 'failed') {
        recordSessionSearchPrimaryFailure(
          store.catalogStorage,
          command.candidate.file.path,
          true,
          true
        )
      }
      if (command.force) {
        store.catalogCandidates.execute({
          kind: 'require',
          path: command.candidate.file.path,
          reason: 'force'
        })
      }
      await queue.enqueue(command.candidate, store, command.force, command.recent, command.metadata)
      break
    case 'get':
      work = await queue.get(command.path)
      break
    case 'next':
      eligibleThrough = command.eligibleThrough ?? queue.eligibleThrough
      works = queue.next(store.connection, eligibleThrough)
      break
    case 'stats':
      break
    case 'acknowledge': {
      const row = store.fileRow(command.work.candidate.file.path)
      const admission = store.catalogCandidates.admission(command.work.candidate)
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
        store.retentionCutoff !== null &&
        command.work.candidate.file.mtimeMs < store.retentionCutoff
      await queue.acknowledge(
        { ...command.work, force: required || (command.work.force && command.retry) },
        transferred || !admission.allowed
          ? false
          : command.handoff
            ? admission.required
            : required
              ? !held && !expired
              : command.retry
      )
      break
    }
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
