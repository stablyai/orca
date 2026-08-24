import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration parent-loss mutation freeze', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it.each([
    ['orchestration.send', { from: 'term_worker', to: 'term_coord', subject: 'mutate' }],
    ['orchestration.taskCreate', { callerTerminalHandle: 'term_worker', spec: 'mutate' }],
    ['orchestration.dispatch', { from: 'term_worker', task: 'task_missing', to: 'term_target' }],
    ['orchestration.ask', { from: 'term_worker', to: 'term_coord', question: 'mutate' }]
  ])('rejects %s before applying effects', async (method, params) => {
    const { db, runtime, ctx } = harness.setup()
    const messagesBefore = db.getInbox().length
    const tasksBefore = db.listTasks().length
    vi.spyOn(runtime, 'assertOrchestrationMutationAllowed').mockImplementation((handle) => {
      if (handle === 'term_worker') {
        throw new OrchestrationError('parent_lost_frozen', 'parent lost', {
          effectsApplied: false
        })
      }
    })

    await expect(harness.call(method, params, ctx)).rejects.toMatchObject({
      code: 'parent_lost_frozen',
      data: { effectsApplied: false }
    })
    expect(db.getInbox()).toHaveLength(messagesBefore)
    expect(db.listTasks()).toHaveLength(tasksBefore)
  })

  it('keeps read-only task listing available to a frozen worker', async () => {
    const { runtime, ctx } = harness.setup()
    const guard = vi
      .spyOn(runtime, 'assertOrchestrationMutationAllowed')
      .mockImplementation(() => undefined)

    await expect(
      harness.call('orchestration.taskList', { callerTerminalHandle: 'term_worker' }, ctx)
    ).resolves.toMatchObject({ count: 0 })
    expect(guard).not.toHaveBeenCalled()
  })
})
