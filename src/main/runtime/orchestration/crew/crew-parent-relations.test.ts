import { expect, it } from 'vitest'
import { buildCrewSnapshot } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { isEquivalentPaneKey } from '../db/pane-key-match'

it('finds retained claims after pane moves and handle remint without merging a known replacement process', () => {
  const { db, deps, handles, assign } = fixture()
  handles.set('term_worker', 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const claim = assign('term_worker')
  db.completeDispatch(claim.id)
  db.db
    .prepare('UPDATE dispatch_contexts SET completed_at = ?, process_incarnation = ? WHERE id = ?')
    .run('2000-01-01', 'process_one', claim.id)
  const moved = handles.get('term_worker')!.replace('tab_worker:', 'tab_moved:')
  handles.delete('term_worker')
  handles.set('term_reminted', moved)
  deps.handleForPane = (pane) =>
    [...handles].find(([, value]) => isEquivalentPaneKey(value, pane))?.[0] ?? null
  deps.processForHandle = () => 'process_one'
  expect(
    buildCrewSnapshot('term_reminted', deps).sections.managedBy.map((row) => row.sendAddress)
  ).toEqual(['term_coord'])
  deps.processForHandle = () => 'process_two'
  expect(buildCrewSnapshot('term_reminted', deps).sections.managedBy).toEqual([])
})

it('reduces a validated same-worker retry before deduping managers with other surviving claims', () => {
  const { db, deps, handles, run } = fixture()
  deps.processForHandle = () => 'process_one'
  const creator = (handle: string) => ({
    kind: 'terminal' as const,
    handle,
    paneKey: handles.get(handle)!
  })
  const first = db.createStartingWorkerDispatch({
    taskSpec: 'Original',
    taskRunId: run.id,
    startOptions: {},
    runtimeEpoch: 'epoch',
    creator: creator('term_coord'),
    maxDepth: 10
  })
  const attach = (id: string, ownership?: 'created' | 'external') =>
    db.prepareStartingWorkerAuthority({
      dispatchId: id,
      handle: 'term_worker',
      paneKey: handles.get('term_worker')!,
      processIncarnation: 'process_one',
      worktreeId: 'wt',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: ownership
    })
  attach(first.dispatch.id)
  db.failWorkerStart(first.dispatch.id, 'boot', 'Failed')
  const retry = db.createStartingWorkerDispatch({
    taskId: first.task.id,
    retryOf: first.dispatch.id,
    startOptions: {},
    runtimeEpoch: 'epoch',
    creator: creator('term_peer'),
    maxDepth: 10
  })
  expect(
    buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.partyKey)
  ).toEqual([JSON.stringify(['test-host', 'term_coord'])])
  attach(retry.dispatch.id)
  expect(
    buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.partyKey)
  ).toEqual([JSON.stringify(['test-host', 'term_peer'])])
  db.markWorkerDispatchReady(retry.dispatch.id)
  db.completeDispatch(retry.dispatch.id)
  db.createDispatchContext({
    taskId: db.createTask({ runId: run.id, spec: 'Independent' }).id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: handles.get('term_worker')!,
    processIncarnation: 'process_one',
    creator: creator('term_coord'),
    maxDepth: 10
  })
  expect(
    buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.partyKey)
  ).toEqual(['term_coord', 'term_peer'].map((address) => JSON.stringify(['test-host', address])))
})
