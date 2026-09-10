import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE_A = 'tab_a:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_B = 'tab_b:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type CheckResult = {
  deliveryId: string | null
  messages: { subject: string }[]
  count: number
  replayed: boolean
}

/** Two processes served one Dispatch mailbox until v36 gave it a consumer generation. */
describe('orchestration.check on a re-attached Dispatch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function attachedDispatchWithMail(): string {
    ;({ db, runtime, ctx } = h.setup())
    const task = db.createTask({ spec: 'worker that gets replaced' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', PANE_A)
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1'
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })
    return dispatch.id
  }

  function check(paneKey: string, params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: paneKey, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  function reattach(dispatchId: string): void {
    db.mintDispatchCapability({
      dispatchId,
      paneKey: PANE_B,
      processIncarnation: 'runtime:pty-b:1'
    })
  }

  /** Same pane, new process: bumps the generation without moving the Dispatch off PANE_A. */
  function remintOnSamePane(dispatchId: string): void {
    db.mintDispatchCapability({
      dispatchId,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:2'
    })
  }

  it('refuses the stale worker its ack and names the re-attach', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    expect(staleDelivery).not.toBeNull()
    reattach(dispatchId)

    await expect(check(PANE_A, { ack: staleDelivery })).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('no longer owns its Dispatch')
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('hands the live worker a fresh Delivery with the same unread mail', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    reattach(dispatchId)

    const live = await check(PANE_B)
    expect(live.deliveryId).not.toBe(staleDelivery)
    expect(live.replayed).toBe(false)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])

    await check(PANE_B, { ack: live.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toEqual([])
  })

  it('keeps serving a worker whose process restarted without a re-attach', async () => {
    attachedDispatchWithMail()
    const first = await check(PANE_A)

    const replay = await check(PANE_A)
    expect(replay.deliveryId).toBe(first.deliveryId)
    expect(replay.replayed).toBe(true)
    await expect(check(PANE_A, { ack: first.deliveryId })).resolves.toMatchObject({
      acknowledged: first.deliveryId
    })
  })

  it('refuses the stale worker a plain check, so it cannot steal the next Delivery', async () => {
    const dispatchId = attachedDispatchWithMail()
    await check(PANE_A)
    reattach(dispatchId)

    await expect(check(PANE_A)).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('no longer owns its Dispatch')
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)

    const live = await check(PANE_B)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])
    await check(PANE_B, { ack: live.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toEqual([])
  })

  // Peek is unfenced against a stale generation, but a caller on the wrong pane is not this
  // mailbox's consumer at all, so it must not read the new owner's instructions either.
  it('refuses the stale worker a --peek at the new owner mail', async () => {
    const dispatchId = attachedDispatchWithMail()
    reattach(dispatchId)

    await expect(check(PANE_A, { peek: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    await expect(check(PANE_A, { all: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('never mints a Delivery at a generation a re-attach already left', async () => {
    const dispatchId = attachedDispatchWithMail()
    const identity = db.getActiveDispatchForIdentity.bind(db)
    let resolved = 0
    vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
      resolved += 1
      if (resolved === 2) {
        remintOnSamePane(dispatchId)
      }
      return identity(handle, paneKey)
    })

    await expect(check(PANE_A)).rejects.toMatchObject({ code: 'consumer_fenced' })

    vi.mocked(db.getActiveDispatchForIdentity).mockRestore()
    const live = await check(PANE_A)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])
  })

  it('fences a blocked --peek whose generation moved while it waited', async () => {
    const dispatchId = attachedDispatchWithMail()
    vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
      remintOnSamePane(dispatchId)
      return 'timed_out'
    })

    // Filtered to a type this mailbox has none of, so the peek actually blocks.
    await expect(
      check(PANE_A, { peek: true, wait: true, types: 'escalation' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('fences before routing the stale worker direct mail into the new owner mailbox', async () => {
    const dispatchId = attachedDispatchWithMail()
    reattach(dispatchId)
    db.insertMessage({ from: 'term_coord', to: 'term_worker', subject: 'direct to the loser' })

    await expect(check(PANE_A)).rejects.toMatchObject({ code: 'consumer_fenced' })

    expect(db.getUnreadMessages('term_worker').map((message) => message.subject)).toEqual([
      'direct to the loser'
    ])
  })

  it('fences a --peek whose Dispatch was re-attached after the caller resolved it', async () => {
    const dispatchId = attachedDispatchWithMail()
    const identity = db.getActiveDispatchForIdentity.bind(db)
    let resolved = 0
    vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
      resolved += 1
      if (resolved === 2) {
        reattach(dispatchId)
      }
      return identity(handle, paneKey)
    })

    await expect(check(PANE_A, { peek: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('serves a worker whose Dispatch row never recorded a pane', async () => {
    ;({ db, runtime, ctx } = h.setup())
    const task = db.createTask({ spec: 'dispatch with no recorded pane' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })

    const result = await check(PANE_A)

    expect(result.messages.map((message) => message.subject)).toEqual(['do the work'])
  })

  it('serves a headless worker whose handle resolves to no pane at all', async () => {
    attachedDispatchWithMail()

    const result = (await h.call(
      'orchestration.check',
      { terminal: 'term_worker' },
      ctx
    )) as CheckResult

    expect(result.messages.map((message) => message.subject)).toEqual(['do the work'])
  })
})
