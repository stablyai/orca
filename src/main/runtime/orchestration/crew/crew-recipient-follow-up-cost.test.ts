import * as followUpPlan from '../db/dispatch-context/worker-follow-up-plan'
import { z } from 'zod'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import { deltaFixture } from './crew-recipient-delta-cost.test-fixture'
import { meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'

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
      f.db.crewChanges.notify(new Set(['topology']))
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
