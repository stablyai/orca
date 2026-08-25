import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration self-send guard', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
  })

  it('rejects an accidental exact self-message and permits an explicit one', async () => {
    const { db, ctx } = h.setup(false)
    const before = db.getInbox().length

    await expect(
      h.call('orchestration.send', { from: 'term_coord', to: 'term_coord', subject: 'loop' }, ctx)
    ).rejects.toThrow('Sender and recipient resolve to the same mailbox')
    expect(db.getInbox()).toHaveLength(before)

    const result = (await h.call(
      'orchestration.send',
      {
        from: 'term_coord',
        to: 'term_coord',
        subject: 'intentional loop',
        allowSelf: true
      },
      ctx
    )) as {
      message: { from_handle: string; to_handle: string }
      audit: { kind: string; from: string; to: string; runId: string | null }
    }

    expect(result.message).toMatchObject({ from_handle: 'term_coord', to_handle: 'term_coord' })
    expect(result.audit).toEqual({
      kind: 'intentional_self_message',
      from: 'term_coord',
      to: 'term_coord',
      runId: null
    })
  })

  it('rejects an omitted recipient that resolves to the sender Run mailbox', async () => {
    const { db, ctx } = h.setup()
    const before = db.getInbox().length

    await expect(
      h.call('orchestration.send', { from: 'term_coord', subject: 'loop' }, ctx)
    ).rejects.toThrow('Sender and recipient resolve to the same mailbox')
    expect(db.getInbox()).toHaveLength(before)
  })

  it('rejects a worker sending to its own Dispatch without lifecycle mutation', async () => {
    const { db, ctx } = h.setup()
    const task = db.createTask({ spec: 'self-target guard' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const before = db.getInbox().length

    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          to: `dispatch:${dispatch.id}`,
          subject: 'self completion',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        },
        ctx
      )
    ).rejects.toThrow('Sender and recipient resolve to the same mailbox')

    expect(db.getInbox()).toHaveLength(before)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('rejects reminted handles that canonicalize to the sender mailbox', async () => {
    const { db, runtime, ctx, activeRunId } = h.setup()
    const remintedPaneKey = 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_reminted'
        ? remintedPaneKey
        : handle === 'term_coord'
          ? h.coordinatorPaneKey
          : null
    )
    vi.mocked(runtime.getLiveTerminalPaneKey).mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    db.bindRun({
      runId: activeRunId!,
      coordinatorHandle: 'term_reminted',
      coordinatorPaneKey: remintedPaneKey
    })

    await expect(
      h.call(
        'orchestration.send',
        { from: 'term_reminted', to: 'term_coord', subject: 'loop after remint' },
        ctx
      )
    ).rejects.toThrow('Sender and recipient resolve to the same mailbox')
  })
})
