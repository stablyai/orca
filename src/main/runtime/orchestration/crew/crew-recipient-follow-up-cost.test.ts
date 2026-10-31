import { OrchestrationError } from '../orchestration-error'
import * as followUpAuthority from './crew-follow-up-authority-inputs'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import * as helperScope from '../../rpc/methods/orchestration/worker/helper-start-scope'
import * as custodyHistory from '../db/pane-key-match'
import { crewQueryPlans, meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'
import * as followUpPlan from '../db/dispatch-context/worker-follow-up-plan'
import { z } from 'zod'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import { deltaFixture } from './crew-recipient-delta-cost.test-fixture'

it('charges selected genuine worker follow-up lineage, origin and caller facts at N and 10N without per-row SQL', () => {
  const samples = [3, 30].map((population) => {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    const roots: string[] = []
    for (let i = 0; i < population; i++) {
      const index = String(i).padStart(2, '0')
      const handle = `term_follow_${index}`
      const pane = `tab_follow_${index}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      f.handles.set(handle, pane)
      const root = f.db.createStartingWorkerDispatch({
        creator: { kind: 'terminal', handle: 'term_coord', paneKey: f.handles.get('term_coord') },
        maxDepth: 10,
        taskSpec: `original ${i}`,
        taskRunId: f.run.id,
        startOptions: { agent: 'codex' }
      })
      f.db.prepareStartingWorkerAuthority({
        dispatchId: root.dispatch.id,
        handle,
        paneKey: pane,
        processIncarnation: `process:${handle}`,
        worktreeId: 'folder-worker-host',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      f.db.markWorkerDispatchReady(root.dispatch.id)
      f.db.settleWorkerReport({
        taskId: root.task.id,
        dispatchId: root.dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
      roots.push(root.dispatch.id)
      const failed = f.db.createStartingWorkerDispatch({
        creator: { kind: 'terminal', handle: 'term_coord', paneKey: f.handles.get('term_coord') },
        maxDepth: 10,
        taskSpec: `unplaced ${i}`,
        taskRunId: f.run.id,
        startOptions: { agent: 'codex' },
        followUpOf: root.dispatch.id
      })
      f.db.failWorkerStart(failed.dispatch.id, 'terminal_create', 'No terminal opened')
    }
    let visits = 0
    const actual = followUpPlan.resolveWorkerLineageFacts
    const traversal = vi
      .spyOn(followUpPlan, 'resolveWorkerLineageFacts')
      .mockImplementation((facts, id) =>
        actual(
          {
            dispatch: (key) => {
              visits++
              return facts.dispatch(key)
            },
            ownedResource: (key) => {
              visits++
              return facts.ownedResource(key)
            },
            formerResource: (key) => {
              visits++
              return facts.formerResource(key)
            },
            followUp: (key) => {
              visits++
              return facts.followUp(key)
            }
          },
          id
        )
      )
    const live = vi.fn(f.deps.livePaneForHandle!)
    const processRead = vi.fn(f.deps.processForHandle!)
    f.deps.livePaneForHandle = live
    f.deps.processForHandle = processRead
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read('term_coord')
      const rows = Object.values(output.sections).flat()
      for (const root of roots) {
        expect(rows.some((row) => row.sendAddress === `dispatch:${root}`)).toBe(true)
      }
      const raw = meter.executions.slice()
      const acquired = raw.filter((entry) => entry.sql.includes('crew_follow_up_seeds'))
      expect(acquired).toHaveLength(1)
      expect(acquired[0].rows).toBe(2 * population)
      const keys = z.array(z.string()).parse(JSON.parse(String(acquired[0].parameters[0])))
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys).toEqual(expect.arrayContaining(roots))
      const work = {
        visits,
        traversals: traversal.mock.calls.length,
        live: live.mock.calls.length,
        process: processRead.mock.calls.length
      }
      const before = meter.executions.length
      expect(model.read('term_coord')).toEqual(output)
      expect(
        meter.executions.slice(before).filter((entry) => entry.sql.includes('crew_follow_up_seeds'))
      ).toHaveLength(0)
      f.db.rekeyWorkerTerminalResourcePaneKey({
        fromPaneKey: f.handles.get('term_follow_00')!,
        toPaneKey: f.handles.get('term_follow_00')!
      })
      expect(model.read('term_coord')).toEqual(output)
      expect(
        meter.executions.filter((entry) => entry.sql.includes('crew_follow_up_seeds'))
      ).toHaveLength(2)
      stop()
      return {
        population,
        selected: sqlTotals(acquired),
        boundKeys: keys.length,
        boundChars: String(acquired[0].parameters[0]).length,
        work,
        output,
        raw
      }
    } finally {
      stop()
      meter.restore()
      traversal.mockRestore()
    }
  })
  process.stdout.write(`Crew follow-up selected work ${JSON.stringify(samples)}\n`)
  for (const field of ['all', 'rows', 'bytes', 'stringChars'] as const) {
    expect(samples[1].selected[field]).toBeLessThanOrEqual(10 * samples[0].selected[field])
  }
  expect(samples[1].boundKeys).toBeLessThanOrEqual(10 * samples[0].boundKeys)
  expect(samples[1].boundChars).toBeLessThanOrEqual(10 * samples[0].boundChars)
  for (const field of ['visits', 'traversals', 'live', 'process'] as const) {
    expect(samples[1].work[field]).toBeLessThanOrEqual(10 * samples[0].work[field])
  }
})

it('shares one caller continuation union across selected starts and charges raw misses, histories and warm recomputation', () => {
  const samples = [
    [3, 3],
    [30, 3],
    [3, 30],
    [30, 30]
  ].map(([eligible, closure]) => {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    const make = (handle: string, creator: string, previous?: string) => {
      f.handles.set(
        handle,
        f.handles.get(handle) ??
          `tab_${handle}:aaaaaaaa-aaaa-4aaa-8aaa-${handle.slice(-2).padStart(12, '0')}`
      )
      const start = f.db.createStartingWorkerDispatch({
        creator: { kind: 'terminal', handle: creator, paneKey: f.handles.get(creator) },
        maxDepth: 100,
        taskRunId: f.run.id,
        taskSpec: `work ${handle}`,
        startOptions: { agent: 'codex' },
        followUpOf: previous
      })
      f.db.prepareStartingWorkerAuthority({
        dispatchId: start.dispatch.id,
        handle,
        paneKey: f.handles.get(handle)!,
        processIncarnation: `process:${handle}`,
        worktreeId: 'folder-worker-host',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: previous ? 'external' : 'created'
      })
      f.db.markWorkerDispatchReady(start.dispatch.id)
      return start
    }
    const settle = (start: ReturnType<typeof make>) =>
      f.db.settleWorkerReport({
        dispatchId: start.dispatch.id,
        taskId: start.task.id,
        outcome: 'succeeded',
        result: 'done'
      })
    let caller = make('term_worker', 'term_coord')
    const targets = Array.from({ length: eligible }, (_, i) => {
      const target = make(`term_cost_${String(i).padStart(2, '0')}`, 'term_worker')
      settle(target)
      return target.dispatch.id
    })
    for (let depth = 1; depth < closure; depth++) {
      settle(caller)
      caller = make('term_worker', 'term_coord', caller.dispatch.id)
    }
    let visits = 0
    const algorithm = helperScope.createHelperStartScope
    const scope = vi
      .spyOn(helperScope, 'createHelperStartScope')
      .mockImplementation((read, creator) =>
        algorithm(
          {
            ...read,
            dispatch: (id) => {
              visits++
              return read.dispatch(id)
            }
          },
          creator
        )
      )
    const decoder = vi.spyOn(custodyHistory, 'parseWorkerTerminalPriorOwnerIds')
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    const authority = (sql: string) =>
      sql.startsWith('SELECT id, run_id, creator_dispatch_id') ||
      sql.includes('prior_owner_dispatch_ids FROM worker_terminal_resources') ||
      sql.startsWith('SELECT id, legacy FROM runs') ||
      sql.startsWith('SELECT dispatch_id, depth')
    try {
      const output = model.read('term_worker')
      for (const id of targets) {
        expect(output.sections.managing.some((row) => row.sendAddress === `dispatch:${id}`)).toBe(
          true
        )
      }
      const cold = meter.executions.filter((entry) => authority(entry.sql))
      const coldVisits = visits
      const histories = decoder.mock.calls.map(([text]) => text.length)
      expect(scope).toHaveBeenCalledTimes(1)
      expect(coldVisits).toBeLessThanOrEqual(eligible + closure + 2)
      expect(histories).toHaveLength(1)
      const queries = cold.map((row) => JSON.stringify([row.sql, row.parameters]))
      expect(new Set(queries).size).toBe(queries.length)
      const mark = meter.executions.length
      expect(model.read('term_worker')).toEqual(output)
      expect(meter.executions.slice(mark).filter((entry) => authority(entry.sql))).toHaveLength(0)
      expect(visits - coldVisits).toBe(coldVisits)
      const plans = crewQueryPlans(f.db.db, cold)
      expect(JSON.stringify(plans)).not.toMatch(
        /SCAN (?:worker_terminal_resources|remote_dispatch_attachments)/
      )
      settle(caller)
      const retired = model.read('term_worker')
      expect(
        retired.sections.managing.every((row) => !row.sendAddress?.startsWith('dispatch:'))
      ).toBe(true)
      const afterWrite = meter.executions.filter((entry) => authority(entry.sql)).length
      expect(afterWrite).toBeGreaterThan(cold.length)
      stop()
      const reacquired = model.read('term_worker')
      expect(reacquired).toEqual(retired)
      expect(meter.executions.filter((entry) => authority(entry.sql)).length).toBeGreaterThan(
        afterWrite
      )
      return {
        eligible,
        closure,
        cold: sqlTotals(cold),
        boundKeys: cold.reduce((n, row) => n + row.parameters.length, 0),
        parameterBytes: cold.reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify(row.parameters)),
          0
        ),
        visits: coldVisits,
        decoderCalls: histories.length,
        historyChars: histories.reduce((a, b) => a + b, 0),
        plans,
        baseline: sqlTotals(meter.executions.filter((entry) => !authority(entry.sql))),
        raw: meter.executions
      }
    } finally {
      stop()
      meter.restore()
      scope.mockRestore()
      decoder.mockRestore()
    }
  })
  process.stdout.write(`Crew helper admission work ${JSON.stringify(samples)}\n`)
  for (const field of ['all', 'rows', 'bytes', 'stringChars'] as const) {
    expect(samples[3].cold[field]).toBeLessThanOrEqual(10 * samples[0].cold[field])
  }
  for (const sample of samples) {
    expect(sample.visits).toBeLessThanOrEqual(sample.eligible + sample.closure + 2)
  }
})

it('rederives warmed authority after committed custody transfer and cancels a real queued publication before reading', async () => {
  const f = deltaFixture()
  f.records.clear()
  f.visible.clear()
  const begin = (creator: string, spec: string) =>
    f.db.createStartingWorkerDispatch({
      creator: { kind: 'terminal', handle: creator, paneKey: f.handles.get(creator) },
      maxDepth: 10,
      taskRunId: f.run.id,
      taskSpec: spec,
      startOptions: {}
    })
  const prepare = (
    start: ReturnType<typeof begin>,
    handle: string,
    ownership: 'created' | 'external'
  ) => {
    f.db.prepareStartingWorkerAuthority({
      dispatchId: start.dispatch.id,
      handle,
      paneKey: f.handles.get(handle)!,
      processIncarnation: `process:${handle}`,
      worktreeId: 'folder-worker-host',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: ownership
    })
    f.db.markWorkerDispatchReady(start.dispatch.id)
  }
  const settle = (start: ReturnType<typeof begin>) =>
    f.db.settleWorkerReport({
      taskId: start.task.id,
      dispatchId: start.dispatch.id,
      outcome: 'succeeded',
      result: 'done'
    })
  const caller = begin('term_coord', 'caller')
  prepare(caller, 'term_worker', 'created')
  const h = begin('term_worker', 'transfer helper')
  prepare(h, 'term_helper', 'created')
  settle(h)
  const h2 = begin('term_worker', 'remaining helper')
  prepare(h2, 'term_grandchild', 'created')
  settle(h2)
  const replacement = begin('term_coord', 'replacement without follow-up edge')
  f.db.insertMessage({
    runId: f.run.id,
    from: `dispatch:${h.dispatch.id}`,
    to: `dispatch:${caller.dispatch.id}`,
    subject: 'Retain helper',
    body: 'recent exchange'
  })
  const resource = f.db.getWorkerTerminalResourceByOwner(h.dispatch.id)!
  const events: string[] = []
  const frames: OrchestrationCrewFrame[] = []
  const exec = f.db.db.exec.bind(f.db.db)
  const transaction = vi.spyOn(f.db.db, 'exec').mockImplementation((sql) => {
    const result = exec(sql)
    if (sql === 'COMMIT') {
      events.push('commit')
    }
    return result
  })
  let invocationVisits = 0
  const actualScope = helperScope.createHelperStartScope
  const scope = vi
    .spyOn(helperScope, 'createHelperStartScope')
    .mockImplementation((readers, creator) =>
      actualScope(
        {
          ...readers,
          dispatch: (id) => {
            invocationVisits++
            return readers.dispatch(id)
          }
        },
        creator
      )
    )
  const meter = meterCrewSql(f.db.db)
  const watch = vi.fn((wake: Parameters<typeof f.db.crewChanges.subscribe>[0]) =>
    f.db.crewChanges.subscribe((facets) => {
      events.push(`wake:${[...facets].join(',')}`)
      wake(facets)
    })
  )
  const model = new CrewReadModel(() => f.deps, watch)
  const read = vi.fn(() => {
    events.push('read')
    return model.read('term_worker')
  })
  const emit = (frame: OrchestrationCrewFrame) => {
    events.push(`frame:${frame.type}`)
    frames.push(frame)
  }
  let stop = subscribeCrew(read, model.subscribe, emit)
  const rows = (output: ReturnType<typeof read>) => Object.values(output.sections).flat()
  const authority = (sql: string) =>
    sql.startsWith('SELECT id, run_id, creator_dispatch_id') ||
    sql.includes('prior_owner_dispatch_ids FROM worker_terminal_resources') ||
    sql.startsWith('SELECT id, legacy FROM runs') ||
    sql.startsWith('SELECT dispatch_id, depth')
  try {
    await Promise.resolve()
    const first = read()
    const old = rows(first).find((row) => row.sendAddress === `dispatch:${h.dispatch.id}`)!
    expect(old.openTarget).toEqual({ kind: 'terminal', handle: 'term_helper' })
    expect(rows(first).some((row) => row.sendAddress === `dispatch:${h2.dispatch.id}`)).toBe(true)
    const warmed = meter.executions.length
    const beforeWarmVisits = invocationVisits
    expect(read()).toEqual(first)
    const warmVisits = invocationVisits - beforeWarmVisits
    expect(warmVisits).toBeGreaterThan(0)
    expect(meter.executions.slice(warmed).filter((row) => authority(row.sql))).toHaveLength(0)
    events.length = 0
    meter.control.phase = 'transfer'
    prepare(replacement, 'term_helper', 'external')
    settle(replacement)
    events.push('writer-return')
    const transferred = f.db.getWorkerTerminalResource(resource.id)!
    expect(transferred.owner_dispatch_id).toBe(replacement.dispatch.id)
    expect(JSON.parse(transferred.prior_owner_dispatch_ids)).toEqual([h.dispatch.id])
    const commit = events.indexOf('commit')
    expect(commit).toBeGreaterThanOrEqual(0)
    expect(events.slice(commit + 1, events.indexOf('writer-return'))).toContain('wake:topology')
    expect(events).not.toContain('read')
    meter.control.phase = 'publication'
    const beforePublicationVisits = invocationVisits
    await Promise.resolve()
    const after = read()
    const retained = rows(after).find((row) => row.partyKey === old.partyKey)!
    expect(retained.openTarget).toEqual(old.openTarget)
    expect(retained.sendAddress).toBe('term_helper')
    expect(rows(after).some((row) => row.sendAddress === `dispatch:${h2.dispatch.id}`)).toBe(true)
    expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('writer-return'))
    expect(events.indexOf('frame:begin')).toBeGreaterThan(events.indexOf('read'))
    expect(meter.executions.some((row) => row.phase === 'publication' && authority(row.sql))).toBe(
      true
    )
    const publicationVisits = invocationVisits - beforePublicationVisits
    expect(publicationVisits).toBeGreaterThan(0)
    const transferEvents = events.slice()
    const beforeWake = events.length
    meter.control.phase = 'queued-writer'
    f.db.insertMessage({
      runId: f.run.id,
      from: `dispatch:${h2.dispatch.id}`,
      to: `dispatch:${caller.dispatch.id}`,
      subject: 'queued traffic',
      body: 'stop before microtask'
    })
    expect(events.slice(beforeWake)).toContain('wake:traffic')
    const baseline = {
      reads: read.mock.calls.length,
      queries: meter.executions.length,
      frames: frames.length
    }
    stop()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(baseline.reads)
    expect(meter.executions).toHaveLength(baseline.queries)
    expect(frames).toHaveLength(baseline.frames)
    meter.control.phase = 'reacquire'
    stop = subscribeCrew(read, model.subscribe, emit)
    expect(watch).toHaveBeenCalledTimes(2)
    const reacquired = read()
    expect(rows(reacquired).find((row) => row.partyKey === old.partyKey)?.sendAddress).toBe(
      'term_helper'
    )
    const equal = frames.length
    await Promise.resolve()
    expect(frames).toHaveLength(equal)
    expect(meter.executions.some((row) => row.phase === 'reacquire' && authority(row.sql))).toBe(
      true
    )
    process.stdout.write(
      `Crew committed transfer queued cancellation ${JSON.stringify({
        transferEvents,
        events,
        baseline,
        warmVisits,
        publicationVisits,
        invocationVisits,
        reads: read.mock.calls.length,
        frames,
        first,
        after,
        reacquired,
        resource: transferred,
        raw: meter.executions
      })}\n`
    )
  } finally {
    stop()
    meter.restore()
    transaction.mockRestore()
    scope.mockRestore()
  }
})

it('publishes unknown for later required coded or schema cohort faults and recovers on real traffic in the same generation', async () => {
  for (const failure of ['coded', 'schema'] as const) {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    const make = (handle: string, creator: string, previous?: string, external = false) => {
      const start = f.db.createStartingWorkerDispatch({
        creator: { kind: 'terminal', handle: creator, paneKey: f.handles.get(creator) },
        maxDepth: 10,
        taskRunId: f.run.id,
        taskSpec: `cohort ${handle}`,
        startOptions: {},
        followUpOf: previous
      })
      f.db.prepareStartingWorkerAuthority({
        dispatchId: start.dispatch.id,
        handle,
        paneKey: f.handles.get(handle)!,
        processIncarnation: `process:${handle}`,
        worktreeId: 'folder-worker-host',
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
    const target = make('term_helper', 'term_worker')
    settle(target)
    settle(a)
    const b = make('term_worker', 'term_coord', a.dispatch.id, true)
    settle(b)
    const c = make('term_worker', 'term_coord', b.dispatch.id, true)
    f.db.insertMessage({
      runId: f.run.id,
      from: `dispatch:${target.dispatch.id}`,
      to: `dispatch:${c.dispatch.id}`,
      subject: 'Retain helper',
      body: 'actual recent exchange'
    })
    const cohortSql = (sql: string) =>
      sql.includes(
        'prior_owner_dispatch_ids FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?'
      )
    const meter = meterCrewSql(f.db.db)
    const fault = new OrchestrationError(
      'task_not_found',
      'required cohort acquisition failed, not semantic denial'
    )
    let armed = true
    let injections = 0
    meter.control.before = (sql) => {
      if (armed && failure === 'coded' && cohortSql(sql)) {
        injections++
        throw fault
      }
    }
    if (failure === 'schema') {
      const prepare = vi.mocked(f.db.db.prepare).getMockImplementation()
      if (!prepare) {
        throw new Error('SQL meter implementation missing')
      }
      vi.mocked(f.db.db.prepare).mockImplementation((sql) => {
        const statement = prepare(sql)
        return {
          all: (...params) => {
            const rows = statement.all(...params)
            if (armed && cohortSql(sql)) {
              injections++
              // Inject a malformed acquisition envelope, not malformed saved history text.
              return rows.map((row) => ({ ...row, prior_owner_dispatch_ids: 9 }))
            }
            return rows
          },
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
          iterate: (...params) => statement.iterate(...params),
          setReadBigInts: (value) => statement.setReadBigInts(value)
        }
      })
    }
    const generations = vi.spyOn(followUpAuthority, 'createCrewFollowUpAuthorityInputs')
    const dependencies = vi.fn(() => f.deps)
    const model = new CrewReadModel(dependencies, f.db.crewChanges.subscribe)
    const facets: string[][] = []
    const unwatch = f.db.crewChanges.subscribe((changed) => facets.push([...changed]))
    const caught: unknown[] = []
    const frames: OrchestrationCrewFrame[] = []
    const stop = subscribeCrew(
      () => {
        try {
          return model.read('term_worker')
        } catch (error) {
          caught.push(error)
          throw error
        }
      },
      model.subscribe,
      (frame) => frames.push(frame)
    )
    try {
      process.stdout.write(
        `Crew later cohort initial ${JSON.stringify({ failure, injections, frames, caught: caught.map((error) => (error instanceof Error ? { name: error.name, message: error.message } : error)), raw: meter.executions })}\n`
      )
      expect(injections).toBe(1)
      expect(caught).toHaveLength(1)
      if (failure === 'coded') {
        expect(caught[0]).toBe(fault)
      } else {
        expect(caught[0]).toMatchObject({
          name: 'ZodError',
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'invalid_type', path: [0, 'prior_owner_dispatch_ids'] })
          ])
        })
      }
      expect(frames).toEqual([{ type: 'begin', status: 'unknown' }, { type: 'complete' }])
      const initial = meter.executions.slice()
      expect(
        initial.some(
          (row) => row.sql.startsWith('SELECT id, run_id, creator_dispatch_id') && row.rows > 0
        )
      ).toBe(true)
      expect(
        initial.some((row) => row.sql.includes('WHERE owner_dispatch_id = ?') && row.rows > 0)
      ).toBe(true)
      const coveredKeys = initial
        .filter(
          (row) =>
            !row.failed &&
            !cohortSql(row.sql) &&
            (row.sql.startsWith('SELECT id, run_id, creator_dispatch_id') ||
              row.sql.includes('prior_owner_dispatch_ids FROM worker_terminal_resources') ||
              row.sql.startsWith('SELECT id, legacy FROM runs') ||
              row.sql.startsWith('SELECT dispatch_id, depth'))
        )
        .map((row) => JSON.stringify([row.sql, row.parameters]))
      armed = false
      meter.control.phase = 'writer'
      f.db.insertMessage({
        runId: f.run.id,
        from: `dispatch:${target.dispatch.id}`,
        to: `dispatch:${c.dispatch.id}`,
        subject: 'Legitimate retry',
        body: 'traffic keeps the raw generation'
      })
      expect(facets).toEqual([['traffic']])
      meter.control.phase = 'retry'
      await Promise.resolve()
      const output = model.read('term_worker')
      const rows = Object.values(output.sections).flat()
      expect(
        rows.filter((row) => row.sendAddress === `dispatch:${target.dispatch.id}`)
      ).toHaveLength(1)
      expect(new Set(rows.map((row) => row.partyKey)).size).toBe(rows.length)
      expect(frames.filter((frame) => frame.type === 'begin')).toEqual([
        { type: 'begin', status: 'unknown' },
        { type: 'begin', status: 'ok' }
      ])
      expect(generations).toHaveBeenCalledTimes(1)
      expect(dependencies).toHaveBeenCalledTimes(1)
      const retry = meter.executions.filter((row) => row.phase === 'retry')
      expect(retry.filter((row) => cohortSql(row.sql))).toHaveLength(1)
      expect(
        retry.filter((row) => coveredKeys.includes(JSON.stringify([row.sql, row.parameters])))
      ).toHaveLength(0)
      const before = meter.executions.length
      const equalFrames = frames.length
      expect(model.read('term_worker')).toEqual(output)
      expect(meter.executions.slice(before).filter((row) => cohortSql(row.sql))).toHaveLength(0)
      expect(frames).toHaveLength(equalFrames)
      expect(injections).toBe(1)
      process.stdout.write(
        `Crew later cohort unknown recovery ${JSON.stringify({
          failure,
          injections,
          sameCodedError: caught[0] === fault,
          facets,
          generations: generations.mock.calls.length,
          frames,
          output,
          coveredKeys,
          initial,
          retry,
          raw: meter.executions
        })}\n`
      )
    } finally {
      stop()
      unwatch()
      meter.restore()
      generations.mockRestore()
    }
  }
})
