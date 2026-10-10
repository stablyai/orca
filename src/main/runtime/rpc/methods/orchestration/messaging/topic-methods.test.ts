import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'

describe('orchestration topic policy RPC', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(): void {
    ;({ db, ctx, activeRunId } = h.setup())
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it('sets and reads one task topic policy in the coordinator Run', async () => {
    setup()
    const task = db.createTask({ runId: activeRunId, spec: 'topic worker' })

    const set = await call('orchestration.topicSet', {
      task: task.id,
      publishes: '["findings"]',
      subscribes: '["review","findings"]',
      callerTerminalHandle: 'term_coord'
    })

    expect(set).toMatchObject({
      policy: {
        taskId: task.id,
        publishes: ['findings'],
        subscribes: ['review', 'findings']
      }
    })

    const shown = await call('orchestration.topicShow', {
      task: task.id,
      callerTerminalHandle: 'term_coord'
    })

    expect(shown).toEqual({
      policy: {
        taskId: task.id,
        runId: activeRunId,
        publishes: ['findings'],
        subscribes: ['review', 'findings']
      }
    })
  })

  it('rejects malformed topics at the RPC boundary without changing policy state', async () => {
    setup()
    const task = db.createTask({ runId: activeRunId, spec: 'topic worker' })

    await expect(
      call('orchestration.topicSet', {
        task: task.id,
        publishes: '["BadCase"]',
        subscribes: '[]',
        callerTerminalHandle: 'term_coord'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(db.getTaskTopicPolicy(task.id)).toBeUndefined()
  })
})
