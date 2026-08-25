import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

// Why: seeding before the row settles keeps the expectation off the row's initial null — a settle that cleared the column would satisfy `toBeNull()` too.
function seedHeartbeatedDispatch(): { d: OrchestrationDb; dispatchId: string } {
  const d = new OrchestrationDb(':memory:')
  db = d
  const task = d.createTask({ spec: 'work' })
  const dispatch = d.createDispatchContext(task.id, 'term_worker')
  d.recordHeartbeat(dispatch.id, '2026-05-03T00:00:00.000Z')
  return { d, dispatchId: dispatch.id }
}

// Why: recordHeartbeat matches status='dispatched' exactly, so every settled status needs its own case — a widened `status != 'completed'` guard shows up only on the failed one.
describe('recordHeartbeat straggler guard', () => {
  it('ignores a straggler heartbeat after the dispatch completed', () => {
    const { d, dispatchId } = seedHeartbeatedDispatch()
    d.completeDispatch(dispatchId)

    d.recordHeartbeat(dispatchId, '2026-05-04T00:00:00.000Z')

    expect(d.getDispatchContextById(dispatchId)?.last_heartbeat_at).toBe('2026-05-03T00:00:00.000Z')
  })

  it('ignores a straggler heartbeat after the dispatch failed', () => {
    const { d, dispatchId } = seedHeartbeatedDispatch()
    d.failDispatch(dispatchId, 'exit')

    d.recordHeartbeat(dispatchId, '2026-05-04T00:00:00.000Z')

    expect(d.getDispatchContextById(dispatchId)?.last_heartbeat_at).toBe('2026-05-03T00:00:00.000Z')
  })
})
