import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { createCrewFollowUpAuthorityInputs } from './crew-follow-up-authority-inputs'
import { createHelperStartScope } from '../../rpc/methods/orchestration/worker/helper-start-scope'
import { assertHelperStartScope } from '../../rpc/methods/orchestration/worker/worker-start-authority'
import { OrchestrationError } from '../orchestration-error'
import { AmbiguousDispatchParentError } from '../db/dispatch-depth'
import { meterCrewSql, crewQueryPlans } from './crew-recipient-sql.test-fixture'
import { CrewReadModel } from './crew-read-model'
import { watchCrewRuntimeSources } from './crew-runtime-watch'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/nested-worker-depth'
import { fixture as settingsFixture } from '../../../persistence/loading-store/profile-state-delayed-authority-fixture'

it('uses the same complete scope with target-before-expansion prefixes and preserves reader-thrown coded failures', () => {
  const f = fixture()
  const caller = f.assign('term_worker')
  const helper = f.assign('term_helper', 'term_worker')
  const foreign = f.assign('term_peer', 'term_helper')
  const read = createCrewFollowUpAuthorityInputs(f.db)
  const fail = new AmbiguousDispatchParentError('raw acquisition failed, not semantic ambiguity')
  const custody = vi.fn(() => {
    throw fail
  })
  const scope = createHelperStartScope({ ...read, owned: custody }, read.dispatch(caller.id)!)
  const args = (id: string) => ({
    task: undefined,
    params: {},
    followUp: { of: id, addressed: id, custodian: id }
  })
  expect(scope(args(helper.id)).kind).toBe('admitted')
  expect(custody).not.toHaveBeenCalled()
  expect(() => scope(args(foreign.id))).toThrow(fail)
  expect(() => assertHelperStartScope(f.db, caller, args(helper.id))).not.toThrow()
  const complete = createHelperStartScope(read, read.dispatch(caller.id)!)
  const refusal = complete(args(foreign.id))
  expect(refusal).toMatchObject({
    kind: 'refused',
    error: { code: 'task_not_found', data: { effectsApplied: false } }
  })
  expect(() => assertHelperStartScope(f.db, caller, args(foreign.id))).toThrow(
    refusal.kind === 'refused' ? refusal.error : 'unexpected'
  )
  const sql = meterCrewSql(f.db.db)
  try {
    const raw = createCrewFollowUpAuthorityInputs(f.db)
    const fault = new OrchestrationError('consumer_fenced', 'SQL fault with familiar code')
    sql.control.before = () => {
      throw fault
    }
    expect(() => raw.dispatch(helper.id)).toThrow(fault)
    sql.control.before = undefined
    expect(raw.dispatch(helper.id)?.creator_dispatch_id).toBe(caller.id)
    const size = sql.executions.length
    expect(raw.dispatch(helper.id)?.id).toBe(helper.id)
    expect(raw.dispatch('ctx_absent')).toBeUndefined()
    expect(raw.dispatch('ctx_absent')).toBeUndefined()
    expect(sql.executions).toHaveLength(size + 1)
    expect(raw.cohort('absent', null)).toEqual([])
    const covered = sql.executions.length
    expect(raw.cohort('absent', null)).toEqual([])
    expect(sql.executions).toHaveLength(covered)
  } finally {
    sql.restore()
  }
})

it('acquires complete indexed pane candidates at N/10N, preserving ambiguity and exact-process filtering', () => {
  for (const population of [3, 30]) {
    const f = fixture()
    const pane = 'tab_remote:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    for (let i = 0; i < population; i++) {
      const id = `remote_${i}`
      f.db.createRemoteDispatchAttachment({
        dispatchId: id,
        taskId: `task_${i}`,
        homePeerFingerprint: 'peer',
        protocolVersion: 1,
        runtimeEpoch: 'epoch',
        depth: i + 1,
        mutationReceipt: {
          callerFingerprint: 'peer',
          requestId: id,
          method: 'start',
          payloadHash: id
        }
      })
      f.db.prepareRemoteAttachmentAuthority({
        dispatchId: id,
        paneKey: `tab_${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        processIncarnation: 'same-process',
        terminalHandle: `term_remote_${i}`,
        worktreeId: 'remote',
        setupState: 'not_applicable',
        effects: []
      })
    }
    // Persisted competing roles are also possible after reconciliation; final shared filtering must see both.
    f.db.db
      .prepare('UPDATE remote_dispatch_attachments SET pane_key = ? WHERE dispatch_id IN (?, ?)')
      .run(pane, 'remote_0', 'remote_1')
    const meter = meterCrewSql(f.db.db)
    try {
      const creator = {
        kind: 'terminal',
        handle: 'term_remote',
        paneKey: pane,
        processIncarnation: 'same-process'
      } as const
      const raw = createCrewFollowUpAuthorityInputs(f.db)
      expect(raw.caller(creator).creatorId()).toMatchObject({
        kind: 'refused',
        error: { name: 'AmbiguousDispatchParentError' }
      })
      expect(() => f.db.resolveCreatorDispatchId(creator)).toThrow(AmbiguousDispatchParentError)
      expect(raw.caller({ ...creator, processIncarnation: 'replacement' }).childDepth(1)).toEqual({
        kind: 'admitted',
        value: 1
      })
      const candidates = meter.executions.filter((entry) =>
        entry.sql.startsWith('SELECT dispatch_id, depth')
      )
      const plans = crewQueryPlans(f.db.db, candidates)
      expect(candidates).toHaveLength(4)
      expect(candidates.reduce((n, row) => n + row.rows, 0)).toBe(8)
      expect(JSON.stringify(plans)).not.toMatch(/SCAN remote_dispatch_attachments/)
    } finally {
      meter.restore()
    }
  }
})

it('recaptures contextual depth through the actual settings writer/topology callback, with retry, equality and disposal', async () => {
  const f = fixture()
  const { store } = await settingsFixture(undefined, { nestedWorkerMaxDepth: 3 })
  const caller = f.assign('term_worker')
  const started = f.db.createStartingWorkerDispatch({
    creator: { kind: 'terminal', handle: 'term_worker', paneKey: f.handles.get('term_worker') },
    maxDepth: 3,
    taskRunId: f.run.id,
    taskSpec: 'real helper',
    startOptions: {}
  })
  f.db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_helper',
    paneKey: f.handles.get('term_helper')!,
    processIncarnation: 'process:term_helper',
    worktreeId: 'test',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  f.db.markWorkerDispatchReady(started.dispatch.id)
  f.db.settleWorkerReport({
    taskId: started.task.id,
    dispatchId: started.dispatch.id,
    outcome: 'succeeded',
    result: 'done'
  })
  f.deps.maxDepth = () => resolveNestedWorkerMaxDepth(store.getSettings())
  const model = new CrewReadModel(
    () => f.deps,
    (wake) =>
      watchCrewRuntimeSources(
        {
          store,
          watchChanges: f.db.crewChanges.subscribe,
          watchTransitions: () => () => {},
          watchClient: () => () => {}
        },
        wake
      )
  )
  const wake = vi.fn()
  const stop = model.subscribe(wake)
  const action = () =>
    model
      .read('term_worker')
      .sections.managing.find(
        (row) => row.openTarget?.kind === 'terminal' && row.openTarget.handle === 'term_helper'
      )
  const meter = meterCrewSql(f.db.db)
  try {
    const first = action()
    expect(first?.sendAddress).toBe(`dispatch:${started.dispatch.id}`)
    store.updateSettings({ nestedWorkerMaxDepth: 1 }, { notifyListeners: true })
    expect(wake).toHaveBeenCalled()
    const lower = action()
    expect(lower?.partyKey).toBe(first?.partyKey)
    expect(lower?.openTarget).toEqual(first?.openTarget)
    expect(lower?.sendAddress).toBe('term_helper')
    store.updateSettings({ nestedWorkerMaxDepth: 3 }, { notifyListeners: true })
    const failure = new OrchestrationError('task_not_found', 'reader failure is not denial')
    // Direct ownership requires no predecessor read; the holder/caller Dispatch read is still required.
    meter.control.before = (sql) => {
      if (sql.startsWith('SELECT id, run_id, creator_dispatch_id')) {
        throw failure
      }
    }
    expect(action).toThrow(failure)
    meter.control.before = undefined
    expect(action()).toEqual(first)
    expect(action()).toEqual(first)
    stop()
    f.db.completeDispatch(caller.id)
    const calls = wake.mock.calls.length
    await Promise.resolve()
    expect(wake).toHaveBeenCalledTimes(calls)
    const again = model.subscribe(wake)
    try {
      expect(action()?.sendAddress).not.toBe(`dispatch:${started.dispatch.id}`)
    } finally {
      again()
    }
  } finally {
    stop()
    meter.restore()
  }
})
