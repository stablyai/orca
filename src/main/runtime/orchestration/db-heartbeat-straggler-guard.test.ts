import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

// Seed a heartbeat so a later null assertion can detect settlement clearing it.
function seedHeartbeatedDispatch(): { d: OrchestrationDb; dispatchId: string } {
  const d = new OrchestrationDb(':memory:')
  db = d
  const task = d.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = createRootDispatch(d, task.id, 'term_worker')
  d.recordHeartbeat(dispatch.id, '2026-05-03T00:00:00.000Z')
  return { d, dispatchId: dispatch.id }
}

// Cover every settled status; failed rows catch a widened status != completed guard.
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
