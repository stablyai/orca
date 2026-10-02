import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { awaitDispatchPreambleTurnDelivered } from './dispatch-preamble-turn'

let db: OrchestrationDb

afterEach(() => {
  db.close()
})

function chatDispatchOwingItsPreamble(): string {
  db = new OrchestrationDb(':memory:')
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'orca_session_id:3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26',
    creator: { kind: 'system' },
    maxDepth: 9
  })
  db.putDispatchPreambleTurn(dispatch.id, 'You are a dispatched worker.')
  return dispatch.id
}

describe("worker-start's wait for a chat to take its preamble", () => {
  it('reports the turn once the chat took it', async () => {
    const dispatchId = chatDispatchOwingItsPreamble()
    db.settleDispatchPreambleTurnSend(dispatchId, 'delivered')
    expect((await awaitDispatchPreambleTurnDelivered(db, dispatchId, 5_000))?.state).toBe(
      'delivered'
    )
  })

  it('ends at once, not delivered, when the Dispatch ended and took the preamble with it', async () => {
    const dispatchId = chatDispatchOwingItsPreamble()
    db.completeDispatch(dispatchId)
    expect(db.getDispatchPreambleTurn(dispatchId)).toBeUndefined()

    const started = Date.now()
    expect(await awaitDispatchPreambleTurnDelivered(db, dispatchId, 5_000)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
