import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

describe('a worker replying to its coordinator', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  it('is waiting on the coordinator even after its handle was reminted', async () => {
    const { db, runtime, ctx } = harness.setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime_test:term_worker:1'
    )
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker_reminted'
        ? 'tab_worker:leaf_worker'
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const hold = db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'HOLD',
      runId: dispatch.run_id
    })
    db.markAsRead([hold.id])
    await harness.call(
      'orchestration.reply',
      { from: 'term_worker_reminted', id: hold.id, body: 'Paused.' },
      ctx
    )
    expect(db.awaitsCoordinator(dispatch.id)).toBe(true)
  })
})
