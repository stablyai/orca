import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const WORKER = 'term_worker'

describe('worker_done from a worker given a newer Dispatch', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  function setupFinishedThenOpen() {
    const { db, runtime, ctx } = harness.setup()
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const send = (taskId: string, dispatchId: string, outcome: string) =>
      harness.call(
        'orchestration.send',
        {
          from: WORKER,
          subject: 'done',
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome })
        },
        ctx
      )
    const first = db.createTask({ spec: 'first' })
    const firstDispatch = createRootDispatch(db, first.id, WORKER)
    return { db, send, first, firstDispatch }
  }

  it('refuses the finished Dispatch IDs and names the open Dispatch', async () => {
    const { db, send, first, firstDispatch } = setupFinishedThenOpen()
    await send(first.id, firstDispatch.id, 'failed')
    const next = db.createTask({ spec: 'next' })
    const open = createRootDispatch(db, next.id, WORKER)
    const messagesBefore = db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()

    await expect(send(first.id, firstDispatch.id, 'succeeded')).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message: expect.stringMatching(`--task-id ${next.id} --dispatch-id ${open.id}.*--type status`)
    })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(messagesBefore)
    expect(db.getDispatchContextById(open.id)?.status).toBe('dispatched')

    await expect(send(next.id, open.id, 'succeeded')).resolves.toMatchObject({
      lifecycle: { action: 'completed' }
    })
  })

  it('keeps plain mail when the newer Dispatch has not reached the worker yet', async () => {
    const { db, send, first, firstDispatch } = setupFinishedThenOpen()
    await send(first.id, firstDispatch.id, 'failed')
    const next = db.createTask({ spec: 'next' })
    const pending = createRootDispatch(db, next.id, WORKER)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'pending' WHERE id = ?").run(pending.id)

    await expect(send(first.id, firstDispatch.id, 'succeeded')).resolves.toMatchObject({
      lifecycle: { action: 'settled' }
    })
  })
})
