import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../../../orchestration/db/messages/mailbox-routing-page'

const WORKER_PANE = 'tab_w:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

type CheckResult = {
  deliveryId: string | null
  messages: { id: string; subject: string }[]
  count: number
  replayed: boolean
  newerMessages?: { subject: string }[]
  newerCount?: number
  newerTruncated?: boolean
  timedOut?: boolean
}

/** An unacknowledged batch replays verbatim, which used to hide everything sent after it. */
describe('orchestration.check on a held, unacknowledged batch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let dispatchId: string

  afterEach(() => {
    h.cleanup()
  })

  function workerHoldingABatch(): Promise<CheckResult> {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'worker that stalls mid-batch' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)
    dispatchId = dispatch.id
    send('first instruction')
    return check()
  }

  function send(subject: string): void {
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject,
      runId: db.getDispatchContextById(dispatchId)!.run_id
    })
  }

  function check(params: Record<string, unknown> = {}): Promise<CheckResult> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness types every handler result as unknown; each test below reads only fields orchestration.check is declared to return, and a shape drift fails that test.
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: WORKER_PANE, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  it('shows the newer message on the replay instead of starving the worker on it', async () => {
    const held = await workerHoldingABatch()
    expect(held.replayed).toBe(false)
    expect(held).not.toHaveProperty('newerMessages')
    send('stop and rebase')

    const replay = await check()

    expect(replay.deliveryId).toBe(held.deliveryId)
    expect(replay.replayed).toBe(true)
    expect(replay.messages.map((message) => message.subject)).toEqual(['first instruction'])
    expect(replay.newerMessages?.map((message) => message.subject)).toEqual(['stop and rebase'])
    expect(replay.newerCount).toBe(1)
    expect(replay.newerTruncated).toBe(false)
  })

  it('says the report is capped when more unread mail is behind the batch than it can carry', async () => {
    await workerHoldingABatch()
    for (let index = 0; index <= ORCHESTRATION_DELIVERY_BATCH_LIMIT; index += 1) {
      send(`queued ${index}`)
    }

    const replay = await check()

    // newerCount is what the receipt carries, not the backlog: the flag is the only thing that
    // distinguishes a mailbox of exactly the limit from one far deeper than it.
    expect(replay.newerCount).toBe(ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    expect(replay.newerTruncated).toBe(true)
  })

  it('shows it to a worker that is waiting rather than returning an unchanged replay', async () => {
    await workerHoldingABatch()
    send('stop and rebase')

    const waited = await check({ wait: true, timeoutMs: 50 })

    expect(waited.replayed).toBe(true)
    expect(waited.newerMessages?.map((message) => message.subject)).toEqual(['stop and rebase'])
  })

  it('reports newer mail without consuming it: the acknowledged batch is the batch handed over', async () => {
    const held = await workerHoldingABatch()
    send('stop and rebase')
    const replay = await check()
    expect(replay.newerCount).toBe(1)

    const next = await check({ ack: held.deliveryId })

    // Acknowledging the held batch marked exactly its own message read; the reported one is
    // handed over by the next Delivery instead.
    expect(next.deliveryId).not.toBe(held.deliveryId)
    expect(next.replayed).toBe(false)
    expect(next.messages.map((message) => message.subject)).toEqual(['stop and rebase'])
    expect(next).not.toHaveProperty('newerMessages')
  })

  it('says nothing when the held batch is still the whole mailbox', async () => {
    await workerHoldingABatch()

    const replay = await check()

    expect(replay.replayed).toBe(true)
    expect(replay).not.toHaveProperty('newerMessages')
    expect(replay).not.toHaveProperty('newerCount')
  })
})
