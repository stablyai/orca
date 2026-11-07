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
        selected: sqlTotals(acquired),
        boundKeys: keys.length,
        boundChars: String(acquired[0].parameters[0]).length,
        work
      }
    } finally {
      stop()
      meter.restore()
      traversal.mockRestore()
    }
  })
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
      return sqlTotals(cold)
    } finally {
      stop()
      meter.restore()
      scope.mockRestore()
      decoder.mockRestore()
    }
  })
  for (const field of ['all', 'rows', 'bytes', 'stringChars'] as const) {
    expect(samples[1][field]).toBeLessThanOrEqual(10 * samples[0][field])
  }
})
