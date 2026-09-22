import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const WORKER_PANE = 'tab_w:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_PANE = 'tab_o:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type CheckResult = {
  runId?: string
  dispatchId?: string
  messages: { subject: string }[]
  count: number
  unservedMailbox?: { kind: string; dispatchId: string; unread: number; readWith: string }
}

/**
 * A reused worker pane that once created a Run keeps that binding for life, and the implicit route
 * serves the Run ahead of the Dispatch — so current assignment guidance never reached it.
 */
describe('orchestration.check mailbox selectors on a dual-role pane', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  /** A pane that coordinates its own child Run AND holds a live Dispatch of its own. */
  function dualRolePane(): { dispatchId: string; childRunId: string } {
    ;({ db, ctx } = h.setup())
    const childRunId = db.createRun({
      objective: 'child run this worker coordinates',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: WORKER_PANE
    }).id
    const task = db.createTask({ spec: 'reused worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime:pty-w:1'
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'current assignment: stop and rebase',
      runId: dispatch.run_id
    })
    db.insertMessage({
      from: 'term_sub',
      to: `run:${childRunId}`,
      subject: 'child run mail',
      runId: childRunId
    })
    return { dispatchId: dispatch.id, childRunId }
  }

  function check(params: Record<string, unknown> = {}): Promise<CheckResult> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness types every handler result as unknown; each test below reads only fields orchestration.check is declared to return, and a shape drift fails that test.
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: WORKER_PANE, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  it('keeps serving the bound Run implicitly and names the Dispatch mailbox it is not serving', async () => {
    const { dispatchId, childRunId } = dualRolePane()

    const result = await check()

    expect(result.runId).toBe(childRunId)
    expect(result.messages.map((message) => message.subject)).toEqual(['child run mail'])
    expect(result.unservedMailbox).toEqual({
      kind: 'dispatch',
      dispatchId,
      unread: 1,
      readWith: `--dispatch ${dispatchId}`
    })
  })

  it('serves the named Dispatch mailbox to the same pane', async () => {
    const { dispatchId } = dualRolePane()

    const result = await check({ dispatch: dispatchId })

    expect(result.dispatchId).toBe(dispatchId)
    expect(result.messages.map((message) => message.subject)).toEqual([
      'current assignment: stop and rebase'
    ])
    expect(result.unservedMailbox).toBeUndefined()
  })

  it('leaves an explicit --run on a dual-role pane serving Run mail', async () => {
    const { childRunId } = dualRolePane()

    const result = await check({ run: childRunId })

    expect(result.runId).toBe(childRunId)
    expect(result.messages.map((message) => message.subject)).toEqual(['child run mail'])
  })

  it('says nothing extra to an intentional child coordinator with no Dispatch of its own', async () => {
    ;({ db, ctx } = h.setup())
    const childRunId = db.createRun({
      objective: 'child run only',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: WORKER_PANE
    }).id
    db.insertMessage({
      from: 'term_sub',
      to: `run:${childRunId}`,
      subject: 'child run mail',
      runId: childRunId
    })

    const result = await check()

    expect(result.runId).toBe(childRunId)
    expect(result).not.toHaveProperty('unservedMailbox')
  })

  it('leaves a plain worker receipt byte-identical for a client that names no selector', async () => {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'plain worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })

    const implicit = await check()

    expect(implicit.dispatchId).toBe(dispatch.id)
    expect(implicit).not.toHaveProperty('unservedMailbox')
  })

  it('refuses a Dispatch held by another pane', async () => {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'someone else' })
    const dispatch = createRootDispatch(db, task.id, 'term_other', OTHER_PANE)

    await expect(check({ dispatch: dispatch.id })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('refuses a Dispatch that was re-attached to another worker process', async () => {
    const { dispatchId } = dualRolePane()
    db.mintDispatchCapability({
      dispatchId,
      paneKey: OTHER_PANE,
      processIncarnation: 'runtime:pty-o:1'
    })

    await expect(check({ dispatch: dispatchId })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('refuses a settled Dispatch instead of serving its mailbox', async () => {
    const { dispatchId } = dualRolePane()
    db.failDispatch(dispatchId, 'the attempt was abandoned')

    await expect(check({ dispatch: dispatchId })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('names an unknown Dispatch id as not found', async () => {
    dualRolePane()

    await expect(check({ dispatch: 'ctx_does_not_exist' })).rejects.toMatchObject({
      code: 'dispatch_not_found'
    })
  })

  it('refuses both selectors together rather than guessing a mailbox', async () => {
    const { dispatchId, childRunId } = dualRolePane()

    await expect(check({ run: childRunId, dispatch: dispatchId })).rejects.toThrow(
      /Choose at most one mailbox selector/
    )
  })
})
