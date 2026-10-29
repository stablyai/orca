import { afterEach, describe, expect, it } from 'vitest'
import { RunEventsPageSchema } from '../../../../../../shared/orchestration-run-events'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('orchestration.runEvents', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  it('returns only the requested Run through the read-only runtime method', async () => {
    const { db, ctx, activeRunId } = harness.setup()
    if (!activeRunId) {
      throw new Error('Expected a bound Run')
    }
    const task = db.createTask({ spec: 'Private implementation details', taskTitle: 'Public task' })
    const other = db.createRun({
      objective: 'Other Run',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    db.createTask({ runId: other.id, spec: 'Other task' })
    const first = RunEventsPageSchema.parse(
      await harness.call('orchestration.runEvents', { id: activeRunId, limit: 1 }, ctx)
    )
    expect(first.events).toMatchObject([{ kind: 'run.created', runId: activeRunId }])
    const second = RunEventsPageSchema.parse(
      await harness.call(
        'orchestration.runEvents',
        {
          id: activeRunId,
          cursor: first.nextCursor
        },
        ctx
      )
    )
    expect(second.events).toMatchObject([
      { kind: 'task.created', entityId: task.id, data: { title: 'Public task' } }
    ])
    expect(second.nextCursor).toBeNull()
    expect(JSON.stringify(second)).not.toContain('Private implementation details')
    expect(JSON.stringify(second)).not.toContain(other.id)
    await expect(
      harness.call('orchestration.runEvents', { id: other.id, cursor: first.nextCursor }, ctx)
    ).rejects.toMatchObject({ code: 'cursor_invalid' })
    await expect(
      harness.call('orchestration.runEvents', { id: 'missing' }, ctx)
    ).rejects.toMatchObject({ code: 'run_not_found' })
  })

  it('rejects unbounded requests before reading history', async () => {
    const { ctx, activeRunId } = harness.setup()
    for (const limit of [0, 101, 1.5]) {
      await expect(
        harness.call('orchestration.runEvents', { id: activeRunId, limit }, ctx)
      ).rejects.toThrow()
    }
    await expect(
      harness.call('orchestration.runEvents', { id: activeRunId, cursor: 'x'.repeat(4097) }, ctx)
    ).rejects.toThrow()
  })
})
