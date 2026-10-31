import * as custodyHistory from '../db/pane-key-match'
import * as creatorEvaluation from '../db/dispatch-creator-evaluation'
import { createWorkerFollowUpQualification } from '../../rpc/methods/orchestration/worker/worker-follow-up-admission'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { createCrewFollowUpAuthorityInputs } from './crew-follow-up-authority-inputs'
import { createHelperStartScope } from '../../rpc/methods/orchestration/worker/helper-start-scope'
import { assertHelperStartScope } from '../../rpc/methods/orchestration/worker/worker-start-authority'
import { OrchestrationError } from '../orchestration-error'
import { AmbiguousDispatchParentError } from '../db/dispatch-depth'
import { meterCrewSql, crewQueryPlans, sqlTotals } from './crew-recipient-sql.test-fixture'
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
  const samples = [3, 30].map((population) => {
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
      return { population, candidates, plans }
    } finally {
      meter.restore()
    }
  })
  process.stdout.write(`Crew remote authority prefilters ${JSON.stringify(samples)}\n`)
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

it('shares overlapping no-resource creation-root paths at fixed E and independently varied target depth', () => {
  const samples = [3, 30].map((targetDepth) => {
    const f = fixture()
    const caller = f.assign('term_worker')
    const chain: string[] = []
    for (let depth = 0; depth < targetDepth; depth++) {
      const started = f.db.createStartingWorkerDispatch({
        creator: {
          kind: 'terminal',
          handle: 'term_worker',
          paneKey: f.handles.get('term_worker')
        },
        maxDepth: 10,
        taskRunId: f.run.id,
        taskSpec: `unplaced target ${depth}`,
        startOptions: {},
        followUpOf: chain.at(-1)
      })
      f.db.failWorkerStart(started.dispatch.id, 'terminal_create', 'No terminal was opened')
      chain.push(started.dispatch.id)
      expect(f.db.getWorkerTerminalResourceByOwner(started.dispatch.id)).toBeUndefined()
    }
    const meter = meterCrewSql(f.db.db)
    const raw = createCrewFollowUpAuthorityInputs(f.db)
    const creator = raw.dispatch(caller.id)!
    const dispatch = vi.fn(raw.dispatch)
    const scope = createHelperStartScope({ ...raw, dispatch }, creator)
    const targets = chain.slice(-3)
    const evaluate = (selected = scope) => {
      for (const id of targets) {
        expect(
          selected({
            task: undefined,
            params: {},
            followUp: { of: id, addressed: id }
          })
        ).toEqual({ kind: 'admitted', value: undefined })
      }
    }
    try {
      expect(targets).toHaveLength(3)
      evaluate()
      const cold = meter.executions.slice()
      const visits = dispatch.mock.calls.length
      const distinct = new Set(dispatch.mock.calls.map(([id]) => id)).size
      expect(visits).toBe(targetDepth + 2)
      expect(distinct).toBe(targetDepth)
      expect(sqlTotals(cold)).toMatchObject({ get: targetDepth + 1, all: 0, rows: targetDepth + 1 })
      const targetReads = cold.filter((row) => row.parameters[0] !== caller.id)
      expect(sqlTotals(targetReads)).toMatchObject({ get: targetDepth, rows: targetDepth })
      evaluate()
      expect(dispatch.mock.calls.length - visits).toBe(targets.length)
      expect(meter.executions).toHaveLength(cold.length)
      const sameScopeReaderCalls = dispatch.mock.calls.length - visits
      evaluate(createHelperStartScope({ ...raw, dispatch }, creator))
      const freshScopeReaderCalls = dispatch.mock.calls.length - visits - sameScopeReaderCalls
      expect(freshScopeReaderCalls).toBe(visits)
      expect(meter.executions).toHaveLength(cold.length)
      meter.control.phase = 'diagnostic'
      return {
        eligible: targets.length,
        targetDepth,
        callerClosure: 1,
        visits,
        distinct,
        sameScopeReaderCalls,
        freshScopeReaderCalls,
        sql: sqlTotals(cold),
        targetSql: sqlTotals(targetReads),
        boundKeys: cold.reduce((n, row) => n + row.parameters.length, 0),
        parameterBytes: cold.reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify(row.parameters)),
          0
        ),
        plans: crewQueryPlans(f.db.db, cold),
        raw: cold
      }
    } finally {
      meter.restore()
    }
  })
  process.stdout.write(`Crew no-resource root work ${JSON.stringify(samples)}\n`)
  for (const field of ['get', 'rows', 'bytes', 'stringChars'] as const) {
    expect(samples[1].sql[field]).toBeLessThanOrEqual(10 * samples[0].sql[field])
  }
})

it('charges complete exact cohorts and history entries independently at fixed caller reach, including fresh warm invocations', () => {
  const samples = [
    [3, 3],
    [30, 3],
    [3, 30]
  ].map(([rowCount, historyLength]) => {
    const f = fixture()
    let serial = 0
    const make = (
      handle: string,
      creator: string,
      previous?: string,
      external = false,
      process = 'cohort'
    ) => {
      if (!f.handles.has(handle)) {
        f.handles.set(
          handle,
          `tab_cohort_${serial}:aaaaaaaa-aaaa-4aaa-8aaa-${String(serial++).padStart(12, '0')}`
        )
      }
      const start = f.db.createStartingWorkerDispatch({
        creator: { kind: 'terminal', handle: creator, paneKey: f.handles.get(creator) },
        maxDepth: 100,
        taskRunId: f.run.id,
        taskSpec: `cohort ${handle}`,
        startOptions: {},
        followUpOf: previous
      })
      f.db.prepareStartingWorkerAuthority({
        dispatchId: start.dispatch.id,
        handle,
        paneKey: f.handles.get(handle)!,
        processIncarnation: process,
        worktreeId: 'test',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: external ? 'external' : 'created'
      })
      f.db.markWorkerDispatchReady(start.dispatch.id)
      return start
    }
    const settle = (start: ReturnType<typeof make>) =>
      f.db.settleWorkerReport({
        taskId: start.task.id,
        dispatchId: start.dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    const a = make('term_worker', 'term_coord')
    const target = make('term_helper', 'term_worker', undefined, false, 'target-process')
    settle(target)
    settle(a)
    const b = make('term_worker', 'term_coord', a.dispatch.id, true)
    settle(b)
    const c = make('term_peer', 'term_coord', b.dispatch.id)
    const holder = make('term_worker', 'term_coord', undefined, true)
    let ancillary = make('term_ancillary', 'term_coord')
    for (let i = 0; i < historyLength; i++) {
      settle(ancillary)
      ancillary = make('term_ancillary', 'term_coord', undefined, true)
    }
    for (let i = 3; i < rowCount; i++) {
      make(`term_extra_${i}`, 'term_coord')
    }
    expect(f.db.getWorkerTerminalResourceByOwner(b.dispatch.id)).toBeUndefined()
    expect(
      f.db.getWorkerTerminalResourceByOwner(holder.dispatch.id)?.prior_owner_dispatch_ids
    ).toBe(JSON.stringify([a.dispatch.id, b.dispatch.id]))
    const raw = createCrewFollowUpAuthorityInputs(f.db)
    const creator = raw.dispatch(c.dispatch.id)!
    const dispatch = vi.fn(raw.dispatch)
    const owned = vi.fn(raw.owned)
    const cohort = vi.fn(raw.cohort)
    const decoder = vi.spyOn(custodyHistory, 'parseWorkerTerminalPriorOwnerIds')
    const meter = meterCrewSql(f.db.db)
    const evaluate = () =>
      createHelperStartScope(
        { ...raw, dispatch, owned, cohort },
        creator
      )({
        task: undefined,
        params: {},
        followUp: {
          of: target.dispatch.id,
          addressed: target.dispatch.id,
          custodian: target.dispatch.id
        }
      })
    try {
      expect(evaluate().kind).toBe('admitted')
      expect(cohort).toHaveBeenCalledExactlyOnceWith('cohort', null)
      expect(owned.mock.calls.map(([id]) => id)).toEqual([c.dispatch.id, b.dispatch.id])
      const cold = meter.executions.slice()
      const calls = dispatch.mock.calls.length
      const histories = decoder.mock.calls.map(([text]) => ({
        entries: JSON.parse(text).length,
        bytes: Buffer.byteLength(text)
      }))
      expect(histories).toHaveLength(rowCount)
      expect(histories.reduce((n, row) => n + row.entries, 0)).toBe(historyLength + 2)
      const cohortQueries = cold.filter((row) =>
        row.sql.includes('WHERE process_incarnation = ? AND host_scope IS ?')
      )
      expect(cohortQueries).toHaveLength(1)
      expect(cohortQueries[0].rows).toBe(rowCount)
      expect(evaluate().kind).toBe('admitted')
      expect(dispatch.mock.calls.length).toBe(2 * calls)
      expect(decoder).toHaveBeenCalledTimes(2 * rowCount)
      expect(cohort).toHaveBeenCalledTimes(2)
      expect(meter.executions).toHaveLength(cold.length)
      meter.control.phase = 'diagnostic'
      return {
        rowCount,
        historyLength,
        callerClosure: [c.dispatch.id, b.dispatch.id, a.dispatch.id],
        histories,
        decodedOwnerEntries: rowCount + histories.reduce((n, row) => n + row.entries, 0),
        historyBytes: histories.reduce((n, row) => n + row.bytes, 0),
        dispatchCalls: calls,
        freshDispatchCalls: dispatch.mock.calls.length - calls,
        ownedCalls: owned.mock.calls,
        cohortCalls: cohort.mock.calls,
        sql: sqlTotals(cold),
        cohortSql: sqlTotals(cohortQueries),
        boundKeys: cold.reduce((n, row) => n + row.parameters.length, 0),
        parameterBytes: cold.reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify(row.parameters)),
          0
        ),
        plans: crewQueryPlans(f.db.db, cold),
        raw: cold
      }
    } finally {
      meter.restore()
      decoder.mockRestore()
    }
  })
  process.stdout.write(`Crew independent cohort history work ${JSON.stringify(samples)}\n`)
  expect(samples.map((s) => s.dispatchCalls)).toEqual([3, 3, 3])
  expect(samples[1].cohortSql.rows).toBe(10 * samples[0].cohortSql.rows)
  expect(samples[2].cohortSql.rows).toBe(samples[0].cohortSql.rows)
  for (const field of ['bytes', 'stringChars'] as const) {
    expect(samples[1].cohortSql[field]).toBeLessThanOrEqual(10 * samples[0].cohortSql[field])
    expect(samples[2].cohortSql[field]).toBeLessThanOrEqual(10 * samples[0].cohortSql[field])
  }
})

it('shares the actual relevant remote predicate across E and repeats it in fresh invocations over covered candidates', () => {
  const samples = [
    [3, 3],
    [30, 3],
    [3, 30]
  ].map(([eligible, candidates]) => {
    const f = fixture()
    const pane = 'tab_remote:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const alternate = 'tab_moved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const targets = Array.from({ length: eligible }, (_, i) => {
      const target = f.assign(`term_target_${i}`)
      f.db.completeDispatch(target.id)
      return target.id
    })
    for (let i = 0; i < candidates; i++) {
      const id = `relevant_${i}`
      f.db.createRemoteDispatchAttachment({
        dispatchId: id,
        taskId: `task_${i}`,
        homePeerFingerprint: 'peer',
        protocolVersion: 1,
        runtimeEpoch: 'epoch',
        depth: i === 0 ? 2 : 1,
        mutationReceipt: {
          callerFingerprint: 'peer',
          requestId: id,
          method: 'start',
          payloadHash: id
        }
      })
      f.db.prepareRemoteAttachmentAuthority({
        dispatchId: id,
        paneKey: `tab_candidate_${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        processIncarnation: i === 0 ? 'current' : 'old',
        terminalHandle: `term_remote_${i}`,
        worktreeId: 'remote',
        setupState: 'not_applicable',
        effects: []
      })
      // Retained competing/equivalent panes after reconciliation; ordinary prepare rejects active competition.
      f.db.db
        .prepare('UPDATE remote_dispatch_attachments SET pane_key = ? WHERE dispatch_id = ?')
        .run(i % 2 === 0 ? pane : alternate, id)
    }
    let predicateVisits = 0
    const actual = creatorEvaluation.createDispatchCreatorEvaluation
    const evaluator = vi
      .spyOn(creatorEvaluation, 'createDispatchCreatorEvaluation')
      .mockImplementation((creator, readers) =>
        actual(creator, {
          ...readers,
          remote: () =>
            readers.remote().map((row) => ({
              ...row,
              get process_incarnation() {
                predicateVisits++
                return row.process_incarnation
              }
            }))
        })
      )
    const equivalent = vi.spyOn(custodyHistory, 'isEquivalentPaneKey')
    const meter = meterCrewSql(f.db.db)
    const raw = createCrewFollowUpAuthorityInputs(f.db)
    const creator = {
      kind: 'terminal',
      handle: 'term_remote',
      paneKey: pane,
      processIncarnation: 'current'
    } as const
    const make = () =>
      createWorkerFollowUpQualification({
        ...raw,
        coordinated: () => raw.run(f.run.id),
        named: raw.run,
        caller: () => raw.caller(creator),
        maxDepth: () => 10
      })
    const evaluate = (qualify: ReturnType<typeof make>) => {
      for (const id of targets) {
        expect(qualify(f.run.id, { of: id, addressed: id })).toMatchObject({
          kind: 'admitted',
          value: { run: { id: f.run.id } }
        })
      }
    }
    try {
      evaluate(make())
      expect(evaluator).toHaveBeenCalledTimes(1)
      expect(predicateVisits).toBe(candidates)
      expect(equivalent).toHaveBeenCalledTimes(1)
      const cold = meter.executions.slice()
      const remote = cold.filter((row) => row.sql.startsWith('SELECT dispatch_id, depth'))
      expect(remote).toHaveLength(2)
      expect(remote.map((row) => row.rows)).toEqual([Math.ceil(candidates / 2), candidates])
      expect(
        new Set(remote.flatMap((row) => row.results.map((value) => value.dispatch_id))).size
      ).toBe(candidates)
      evaluate(make())
      expect(evaluator).toHaveBeenCalledTimes(2)
      expect(predicateVisits).toBe(2 * candidates)
      expect(equivalent).toHaveBeenCalledTimes(2)
      expect(meter.executions).toHaveLength(cold.length)
      meter.control.phase = 'diagnostic'
      const plans = crewQueryPlans(f.db.db, remote)
      expect(JSON.stringify(plans)).not.toMatch(/SCAN remote_dispatch_attachments/)
      return {
        eligible,
        candidates,
        predicateVisits,
        paneComparisons: equivalent.mock.calls.length,
        survivingPerInvocation: 1,
        sql: sqlTotals(cold),
        remote: sqlTotals(remote),
        boundKeys: cold.reduce((n, row) => n + row.parameters.length, 0),
        parameterBytes: cold.reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify(row.parameters)),
          0
        ),
        plans,
        raw: cold
      }
    } finally {
      meter.restore()
      evaluator.mockRestore()
      equivalent.mockRestore()
    }
  })
  process.stdout.write(`Crew relevant remote filter work ${JSON.stringify(samples)}\n`)
  expect(samples[1].predicateVisits).toBe(samples[0].predicateVisits)
  expect(samples[2].predicateVisits).toBe(10 * samples[0].predicateVisits)
  for (const field of ['bytes', 'stringChars', 'rows'] as const) {
    expect(samples[2].remote[field]).toBeLessThanOrEqual(10 * samples[0].remote[field])
  }
})

it('keeps a failed remote composite uncovered on the same adapter/key and retries its successful prefix without duplicates', () => {
  const f = fixture()
  const pane = 'tab_retry:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  f.db.createRemoteDispatchAttachment({
    dispatchId: 'remote_retry',
    taskId: 'task_retry',
    homePeerFingerprint: 'peer',
    protocolVersion: 1,
    runtimeEpoch: 'epoch',
    depth: 2,
    mutationReceipt: {
      callerFingerprint: 'peer',
      requestId: 'retry',
      method: 'start',
      payloadHash: 'retry'
    }
  })
  f.db.prepareRemoteAttachmentAuthority({
    dispatchId: 'remote_retry',
    paneKey: pane,
    processIncarnation: 'current',
    terminalHandle: 'term_retry',
    worktreeId: 'remote',
    setupState: 'not_applicable',
    effects: []
  })
  const raw = createCrewFollowUpAuthorityInputs(f.db)
  const meter = meterCrewSql(f.db.db)
  const fault = new AmbiguousDispatchParentError(
    'coded reader failure, not complete semantic ambiguity'
  )
  const caller = raw.caller({
    kind: 'terminal',
    handle: 'term_retry',
    paneKey: pane,
    processIncarnation: 'current'
  })
  try {
    expect(raw.run(f.run.id)?.id).toBe(f.run.id)
    meter.control.before = (sql) => {
      if (sql.startsWith('SELECT dispatch_id, depth') && sql.includes('substr(')) {
        throw fault
      }
    }
    expect(() => caller.childDepth(10)).toThrow(fault)
    const failed = meter.executions.filter((row) => row.sql.startsWith('SELECT dispatch_id, depth'))
    expect(failed.map((row) => [row.rows, row.failed])).toEqual([
      [1, false],
      [0, true]
    ])
    meter.control.before = undefined
    meter.control.phase = 'retry'
    expect(caller.creatorId()).toEqual({ kind: 'admitted', value: 'remote_retry' })
    expect(caller.childDepth(10)).toEqual({ kind: 'admitted', value: 3 })
    const retried = meter.executions.filter((row) => row.phase === 'retry')
    expect(retried.map((row) => row.rows)).toEqual([1, 1])
    const size = meter.executions.length
    expect(raw.run(f.run.id)?.id).toBe(f.run.id)
    expect(
      raw
        .caller({
          kind: 'terminal',
          handle: 'term_retry',
          paneKey: pane,
          processIncarnation: 'current'
        })
        .creatorId()
    ).toEqual({ kind: 'admitted', value: 'remote_retry' })
    expect(meter.executions).toHaveLength(size)
    expect(raw.cohort('empty', null)).toEqual([])
    const empty = meter.executions.length
    expect(raw.cohort('empty', null)).toEqual([])
    expect(meter.executions).toHaveLength(empty)
    expect(
      meter.executions.filter((row) => row.sql === 'SELECT id, legacy FROM runs WHERE id = ?')
    ).toHaveLength(1)
    process.stdout.write(
      `Crew remote incomplete retry ${JSON.stringify({ sameError: failed[1].failed, failed, retried, executions: meter.executions })}\n`
    )
  } finally {
    meter.restore()
  }
})
