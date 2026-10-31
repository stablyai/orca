import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCrewSnapshot, CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { subscribeCrew } from './crew-stream'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { federatedStubHomeRunId } from '../db/contract-constants'
import { maximalCrewClaims } from './crew-claim-reduction'
import { isEquivalentPaneKey } from '../db/pane-key-match'

afterEach(() => vi.useRealTimers())

describe('durable crew parents', () => {
  it('composes incomparable local and remote claims through terminal outcomes without re-aging Managing', async () => {
    const { db, deps, handles, assign } = fixture()
    deps.processForHandle = () => 'process_one'
    const local = assign('term_worker')
    const now = 1_800_000_000_000
    vi.useFakeTimers({ now })
    db.completeDispatch(local.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
      .run(new Date(now - AGENT_STATUS_STALE_AFTER_MS - 1).toISOString(), local.id)
    const acquire = vi.fn(() => deps)
    const model = new CrewReadModel(acquire, db.crewChanges.subscribe)
    let current = buildCrewSnapshot('term_worker', deps)
    const stop = subscribeCrew(
      () => {
        current = model.read('term_worker')
        return current
      },
      model.subscribe,
      () => {}
    )
    const attach = (id: string, home: string, runId?: string) => {
      db.createRemoteDispatchAttachment({
        dispatchId: id,
        runId,
        taskId: `task_${id}`,
        homePeerFingerprint: home,
        runtimeEpoch: 'epoch',
        protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
        mutationReceipt: {
          callerFingerprint: home,
          requestId: id,
          method: 'orchestration.federationAttachStart',
          payloadHash: id
        }
      })
      db.prepareRemoteAttachmentAuthority({
        dispatchId: id,
        terminalHandle: 'term_worker',
        paneKey: handles.get('term_worker')!,
        processIncarnation: 'process_one',
        worktreeId: 'wt',
        setupState: 'not_applicable',
        effects: []
      })
    }
    attach('ctx_remote', 'home', 'run_home')
    db.markRemoteAttachmentReady('ctx_remote')
    await Promise.resolve()
    await Promise.resolve()
    const expected = [
      JSON.stringify(['test-host', 'term_coord']),
      JSON.stringify(['home', 'run:run_home'])
    ].sort()
    expect(current.sections.managedBy.map((row) => row.partyKey).sort()).toEqual(expected)
    expect(
      current.sections.managedBy.find(
        (row) => row.partyKey === JSON.stringify(['home', 'run:run_home'])
      )?.sendAddress
    ).toBe('run:run_home')
    expect(
      current.sections.managedBy.find(
        (row) => row.partyKey === JSON.stringify(['test-host', 'term_coord'])
      )
    ).not.toHaveProperty('sendAddress')
    expect(buildCrewSnapshot('term_coord', deps).sections.managing).toEqual([])
    db.beginRemoteAttachmentStop('ctx_remote')
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managedBy.every((row) => !row.sendAddress)
    ).toBe(true)
    db.markRemoteAttachmentStopUnknown('ctx_remote', 'Unknown stop')
    await Promise.resolve()
    await Promise.resolve()
    expect(current.sections.managedBy.map((row) => row.partyKey).sort()).toEqual(expected)
    db.recordRemoteAttachmentStage({
      dispatchId: 'ctx_remote',
      stage: 'reconciled',
      state: 'start_unknown'
    })
    db.beginRemoteAttachmentStop('ctx_remote')
    db.settleRemoteAttachmentStop('ctx_remote')
    await Promise.resolve()
    await Promise.resolve()
    expect(current.sections.managedBy.map((row) => row.partyKey).sort()).toEqual(expected)
    for (const state of [
      'start_unknown',
      'stopping',
      'stop_unknown',
      'succeeded',
      'failed',
      'stopped',
      'abandoned'
    ] as const) {
      const before = acquire.mock.calls.length
      db.recordRemoteAttachmentStage({ dispatchId: 'ctx_remote', stage: state, state })
      db.updateRemoteAttachmentSetupEvidence({
        dispatchId: 'ctx_remote',
        setupState: 'late',
        effects: []
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(acquire).toHaveBeenCalledTimes(before + 1)
      expect(current.sections.managedBy.map((row) => row.partyKey).sort()).toEqual(expected)
      expect(
        current.sections.managedBy.find(
          (row) => row.partyKey === JSON.stringify(['home', 'run:run_home'])
        )?.sendAddress
      ).toBe(state === 'start_unknown' || state === 'stop_unknown' ? 'run:run_home' : undefined)
      expect(buildCrewSnapshot('term_coord', deps).sections.managing).toEqual([])
    }
    attach('ctx_legacy_remote', 'home')
    db.failRemoteAttachment('ctx_legacy_remote', 'start', 'Failed', false)
    const stub = federatedStubHomeRunId('ctx_legacy_remote')
    expect(db.getRunRaw(stub)?.home_database).toBe('remote')
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.sendAddress)
    ).not.toContain(`run:${stub}`)
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.partyKey)
    ).toContain(JSON.stringify(['home', `run:${stub}`]))
    db.recordRemoteAttachmentStage({ dispatchId: 'ctx_legacy_remote', stage: 'released' })
    db.recordRemoteAttachmentStage({ dispatchId: 'ctx_remote', stage: 'ready', state: 'ready' })
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managedBy.find(
        (row) => row.partyKey === JSON.stringify(['home', 'run:run_home'])
      )?.sendAddress
    ).toBe('run:run_home')
    deps.processForHandle = () => 'process_replaced'
    db.crewChanges.notify()
    await Promise.resolve()
    await Promise.resolve()
    expect(current.sections.managedBy.map((row) => row.sendAddress)).not.toContain('run:run_home')
    stop()
  })

  it('hydrates retained creator IDs and reduces retries only after same-worker acquisition, then dedupes managers', () => {
    const { db, deps, run, handles, assign } = fixture()
    const creator = assign('term_helper', 'term_coord', 'Creator')
    const child = assign('term_worker', 'term_helper')
    db.completeDispatch(creator.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', creator.id)
    expect(buildCrewSnapshot('term_worker', deps).sections.managedBy[0].sendAddress).toBe(
      'term_helper'
    )
    db.failDispatch(child.id, 'retry')
    db.updateTaskStatus(child.task_id, 'failed')
    const retry = db.createStartingWorkerDispatch({
      taskId: child.task_id,
      retryOf: child.id,
      startOptions: {},
      creator: { kind: 'terminal', handle: 'term_peer', paneKey: handles.get('term_peer')! },
      maxDepth: 10
    })
    const before = buildCrewSnapshot('term_worker', deps).sections.managedBy
    expect(before).toHaveLength(1)
    db.prepareStartingWorkerAuthority({
      dispatchId: retry.dispatch.id,
      handle: 'term_outbound',
      paneKey: handles.get('term_outbound')!,
      processIncarnation: 'different',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_applicable'
    })
    expect(buildCrewSnapshot('term_worker', deps).sections.managedBy).toEqual(before)
    expect(db.getRunRaw(run.id)).toBeDefined()
  })
})

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

it('uses an exact owned transfer chain and refuses external or corrupt history as replacement proof', () => {
  for (const ownership of ['created', 'external'] as const) {
    const { db, deps, handles, run } = fixture()
    const processForHandle = deps.processForHandle
    deps.processForHandle = (handle) =>
      handle === 'term_worker' ? 'process_one' : (processForHandle?.(handle) ?? null)
    const start = (manager: string) =>
      db.createStartingWorkerDispatch({
        taskSpec: 'Transfer',
        taskRunId: run.id,
        startOptions: {},
        runtimeEpoch: 'epoch',
        creator: { kind: 'terminal', handle: manager, paneKey: handles.get(manager)! },
        maxDepth: 10
      })
    const attach = (id: string, terminalOwnership: 'created' | 'external') =>
      db.prepareStartingWorkerAuthority({
        dispatchId: id,
        handle: 'term_worker',
        paneKey: handles.get('term_worker')!,
        processIncarnation: 'process_one',
        worktreeId: 'wt',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership
      })
    const first = start('term_coord')
    attach(first.dispatch.id, ownership)
    db.failWorkerStart(first.dispatch.id, 'boot', 'Failed')
    const next = start('term_peer')
    attach(next.dispatch.id, 'external')
    const keys = () =>
      buildCrewSnapshot('term_worker', deps).sections.managedBy.map((row) => row.partyKey)
    expect(keys()).toHaveLength(ownership === 'created' ? 1 : 2)
    if (ownership === 'created') {
      const resource = db.getWorkerTerminalResourceByOwner(next.dispatch.id)!
      db.db
        .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
        .run(JSON.stringify(['ctx_missing', first.dispatch.id]), resource.id)
      expect(keys()).toHaveLength(2)
    }
  }
})

it('retains every member of a corrupt replacement cycle even when one member has another successor', () => {
  expect(
    maximalCrewClaims(
      ['a', 'b', 'c', 'd'],
      new Map([
        ['a', new Set(['b'])],
        ['b', new Set(['a', 'c'])],
        ['d', new Set(['c'])]
      ])
    )
  ).toEqual(new Set(['a', 'b', 'c']))
})

it('collapses loopback representations only with existing source, worker, task and Run provenance', () => {
  const { db, deps, run, handles } = fixture()
  const processForHandle = deps.processForHandle
  deps.processForHandle = (handle) =>
    handle === 'term_worker' ? 'process_one' : (processForHandle?.(handle) ?? null)
  const home = db.getOrCreateLocalMutationCallerFingerprint()
  const local = db.createStartingWorkerDispatch({
    taskRunId: run.id,
    taskSpec: 'Loopback',
    startOptions: {},
    runtimeEpoch: 'epoch',
    creator: { kind: 'system' },
    maxDepth: 10
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: local.dispatch.id,
    handle: 'term_worker',
    paneKey: handles.get('term_worker')!,
    processIncarnation: 'process_one',
    worktreeId: 'wt',
    effects: [],
    setupState: 'not_applicable'
  })
  db.createRemoteDispatchAttachment({
    dispatchId: local.dispatch.id,
    runId: run.id,
    taskId: local.task.id,
    homePeerFingerprint: home,
    runtimeEpoch: 'epoch',
    protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
    mutationReceipt: {
      callerFingerprint: home,
      requestId: 'loopback',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'loopback'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId: local.dispatch.id,
    terminalHandle: 'term_worker',
    paneKey: handles.get('term_worker')!,
    processIncarnation: 'process_one',
    worktreeId: 'wt',
    effects: [],
    setupState: 'not_applicable'
  })
  expect(buildCrewSnapshot('term_worker', deps).sections.managedBy).toHaveLength(1)
  db.db
    .prepare(
      'UPDATE remote_dispatch_attachments SET home_peer_fingerprint = ? WHERE dispatch_id = ?'
    )
    .run('another-home', local.dispatch.id)
  expect(buildCrewSnapshot('term_worker', deps).sections.managedBy).toHaveLength(2)
})
