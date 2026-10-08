import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { RpcDispatcher } from '../../../dispatcher'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

// What the sender asks a chat that is mid-turn to do with its message: stored on every row, read
// by the pointer that nudges the chat later.
describe('orchestration send and dispatch --delivery', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup())
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
  }

  afterEach(() => {
    h.cleanup()
  })

  function storedDeliveries(): (string | undefined)[] {
    return db.getInbox(100).map((message) => message.busy_delivery)
  }

  async function refusal(params: Record<string, unknown>, method = 'orchestration.send') {
    const response = await new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch({
      id: 'req_1',
      authToken: 'token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
    return response.ok ? null : response.error
  }

  it('stores a steer on the message, and keeps it out of the receipt', async () => {
    setup()
    const result = await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `run:${activeRunId}`, subject: 'now', delivery: 'steer' },
      ctx
    )

    expect(storedDeliveries()).toEqual(['steer'])
    expect(result).toHaveProperty('message.id')
    expect(result).not.toHaveProperty('message.busy_delivery')
  })

  it('queues by default', async () => {
    setup()
    await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `run:${activeRunId}`, subject: 'later' },
      ctx
    )

    expect(storedDeliveries()).toEqual(['queue'])
  })

  it('stores the choice on every message a group send writes', async () => {
    setup()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    for (const handle of ['term_a', 'term_b']) {
      createRootDispatch(db, db.createTask({ spec: `work for ${handle}` }).id, handle)
    }
    await h.call(
      'orchestration.send',
      { from: 'term_coord', to: '@all', subject: 'stop', delivery: 'steer' },
      ctx
    )

    expect(storedDeliveries()).toEqual(['steer', 'steer'])
  })

  it('refuses a value it does not know, writing nothing', async () => {
    setup()
    expect(
      await refusal({
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'x',
        delivery: 'restart'
      })
    ).toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('--delivery') })
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it('refuses a heartbeat that would steer, writing nothing', async () => {
    setup()
    expect(
      await refusal({
        from: 'term_worker',
        subject: 'beat',
        type: 'heartbeat',
        delivery: 'steer'
      })
    ).toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('heartbeat') })
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it('refuses a dispatch --delivery without --inject, which would send the task nowhere', async () => {
    setup()
    const task = db.createTask({ spec: 'work' })
    expect(
      await refusal(
        { task: task.id, to: 'term_worker', from: 'term_coord', delivery: 'steer' },
        'orchestration.dispatch'
      )
    ).toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('--inject') })
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })
})
