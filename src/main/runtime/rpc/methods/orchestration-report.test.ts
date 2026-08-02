import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_REPORT_METHODS } from './orchestration-report'

describe('orchestration.report RPC', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('reads the selected Run through the existing runtime database', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'redacted',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    db.createTask({ runId: run.id, spec: 'redacted task' })
    const method = ORCHESTRATION_REPORT_METHODS[0]

    const result = await method.handler({ id: run.id }, {
      runtime: {
        getOrchestrationDb: () => db,
        getOrchestrationUsageSnapshots: () => [],
        resolveOrchestrationReportWorktreeHostScope: () => 'local'
      }
    } as never)

    expect(result).toMatchObject({
      schemaVersion: 1,
      run: { id: run.id },
      graph: { rootTaskIds: [expect.stringMatching(/^task_/)] }
    })
  })

  it('returns run_not_found without creating records', () => {
    db = new OrchestrationDb(':memory:')
    const method = ORCHESTRATION_REPORT_METHODS[0]

    expect(() =>
      method.handler({ id: 'run_missing' }, {
        runtime: {
          getOrchestrationDb: () => db,
          getOrchestrationUsageSnapshots: () => [],
          resolveOrchestrationReportWorktreeHostScope: () => 'local'
        }
      } as never)
    ).toThrow(expect.objectContaining({ code: 'run_not_found' }))
    expect(db.listRuns().runs).toHaveLength(1)
  })
})
