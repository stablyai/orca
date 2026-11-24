import { afterEach, beforeEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

let db: OrchestrationDb

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
})

it('holds a slot for uncertain starts and rolls back a refused dispatch until a worker settles', () => {
  const run = db.createRun({
    objective: 'Bot work',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const start = (spec: string) =>
    db.createStartingWorkerDispatch({
      taskRunId: run.id,
      taskSpec: spec,
      creator: { kind: 'system' },
      maxDepth: 4,
      startOptions: {},
      chatLineage: true,
      mutationReceipt: {
        callerFingerprint: 'test-caller',
        requestId: spec,
        method: 'orchestration.workerStart',
        payloadHash: spec
      }
    })

  const [first, uncertain] = Array.from({ length: 8 }, (_, index) => start(`Task ${index}`))
  db.markWorkerStartUnknown(uncertain.dispatch.id, 'remote_attach_requested', 'Connection lost')

  expect(() => start('Overflow')).toThrow('This Run already has 8 active workers.')
  expect(db.getMutationReceipt('test-caller', 'Overflow')).toBeUndefined()
  expect(db.listTasks({ runId: run.id })).toHaveLength(8)

  db.failWorkerStart(first.dispatch.id, 'terminal_create', 'Launch refused')
  expect(start('Overflow').worker.state).toBe('starting')
})
