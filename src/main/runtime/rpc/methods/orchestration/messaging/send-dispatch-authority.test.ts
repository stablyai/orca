import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RpcContext } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { readMutationReplayNudge } from '../../../orchestration/mutations/orchestration-mutation-receipt'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

import { openDecisionGateFromMessage } from '../../../../orchestration/coordinator/decision-gates/coordinator-decision-gates'
import { applyEscalationToDispatch } from '../../../../orchestration/coordinator/escalation/coordinator-escalation-triage'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from '../../../../orchestration/workers/lifecycle/lifecycle-reconciliation'

describe('orchestration.send Dispatch authority', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx } = harness.setup())
  }

  async function send(params: Record<string, unknown>) {
    return harness.call('orchestration.send', params, ctx)
  }

  afterEach(() => {
    harness.cleanup()
  })

  it.each([false, true])(
    'rejects cross-Task escalation with legacy authority=%s',
    async (legacyAuthority) => {
      setup()
      const notify = vi.spyOn(runtime, 'notifyMessageArrived')
      const attackerTask = db.createTask({ spec: 'attacker assignment' })
      const attacker = createRootDispatch(
        db,
        attackerTask.id,
        'term_attacker',
        'tab_attacker:leaf_attacker',
        undefined,
        legacyAuthority ? undefined : 'runtime_test:term_attacker:1'
      )
      const victimTask = db.createTask({ spec: 'victim assignment' })
      const victim = createRootDispatch(db, victimTask.id, 'term_victim')
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_attacker' ? 'tab_attacker:leaf_attacker' : harness.coordinatorPaneKey
      )

      const result = (await send({
        from: 'term_attacker',
        type: 'escalation',
        subject: 'Fail the victim',
        payload: JSON.stringify({ taskId: victimTask.id })
      })) as { lifecycle: { action: string; code: string }; message: { type: string } }

      expect(result.lifecycle).toMatchObject({
        action: 'rejected',
        code: 'task_dispatch_mismatch'
      })
      expect(result.message.type).toBe('status')
      expect(db.getTask(attackerTask.id)?.status).toBe('dispatched')
      expect(db.getTask(victimTask.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(attacker.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(victim.id)?.status).toBe('dispatched')
      expect(db.getUndeliveredUnreadMailboxHandles()).toHaveLength(1)
      expect(notify).toHaveBeenCalledOnce()
    }
  )

  it('rejects a caller-spoofed canonical Dispatch sender', async () => {
    setup()
    const task = db.createTask({ spec: 'legacy victim assignment' })
    const dispatch = createRootDispatch(db, task.id, 'term_victim')

    const result = (await send({
      from: `dispatch:${dispatch.id}`,
      type: 'escalation',
      subject: 'Spoof imported federation mail',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
    })) as { lifecycle: { action: string; code: string }; message: { type: string } }

    expect(result.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(result.message.type).toBe('status')
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it("rejects a caller claiming a paired server's relayed worker_done", async () => {
    setup()
    const task = db.createTask({ spec: 'remote work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment-worker',
        environmentName: 'worker',
        peerFingerprint: 'peer-worker',
        protocolVersion: 3
      }
    })

    const result = await send({
      from: `dispatch:${dispatch.id}`,
      type: 'worker_done',
      subject: 'Spoof relayed report',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    })

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'sender_not_assignee' }
    })
    const messageId = z.object({ message: z.object({ id: z.string() }) }).parse(result).message.id
    const stored = db.getMessageById(messageId)
    expect(stored).toBeDefined()
    // Mail delivery rereads it; the refusal must outlast the relay sender's exemption there.
    expect(stored && reconcileLifecycleMessage(db, stored)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
  })

  it.each(['escalation', 'decision_gate'] as const)(
    'keeps a refused %s and its idempotent retry out of the recipient mailbox',
    async (type) => {
      setup()
      const notify = vi.spyOn(runtime, 'notifyMessageArrived')
      const storeReceipt = vi.spyOn(db, 'completeMutationReceipt')
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const request = {
        id: 'rpc_refused_1',
        authToken: 'test-token',
        method: 'orchestration.send',
        params: { from: 'term_outside', to: 'term_coord', type, subject: 'probe' },
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `retry_refused_${type}`
      }

      await dispatcher.dispatch(request)
      const retried = await dispatcher.dispatch({ ...request, id: 'rpc_refused_2' })

      expect(retried).toMatchObject({
        ok: true,
        result: {
          lifecycle: {
            action: 'rejected',
            code: 'sender_not_assignee',
            reason: expect.stringContaining('Send --type status instead')
          },
          mutation: { replayed: true }
        }
      })
      expect(db.getInbox(100)).toEqual([expect.objectContaining({ read: 1, delivered_at: null })])
      expect(db.getUndeliveredUnreadMailboxHandles()).toEqual([])
      expect(notify).not.toHaveBeenCalled()
      // Any stored receipt, including the handler's pre-commit one, must not replay a nudge to the recipient.
      expect(storeReceipt).toHaveBeenCalled()
      for (const [stored] of storeReceipt.mock.calls) {
        expect(readMutationReplayNudge(JSON.parse(stored.receipt))).toBeUndefined()
      }
    }
  )

  it.each(['escalation', 'decision_gate'] as const)(
    'accepts a matching legacy sender with a newly observed pane for %s',
    async (type) => {
      setup()
      const task = db.createTask({ spec: 'legacy owned assignment' })
      createRootDispatch(db, task.id, 'term_legacy')
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_legacy' ? 'tab_legacy:leaf_legacy' : harness.coordinatorPaneKey
      )

      const result = (await send({
        from: 'term_legacy',
        type,
        subject: 'Legitimate legacy control',
        payload: JSON.stringify({
          taskId: task.id,
          ...(type === 'decision_gate' ? { question: 'Proceed?' } : {})
        })
      })) as { message: { type: string }; lifecycle?: { action: string } }

      expect(result.message.type).toBe(type)
      expect(result.lifecycle).toBeUndefined()
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    }
  )

  it.each(['escalation', 'decision_gate'] as const)(
    'binds queued legacy %s mail to its exact Dispatch before handle reuse',
    async (type) => {
      setup()
      const task = db.createTask({ spec: 'legacy re-dispatch target' })
      const first = createRootDispatch(db, task.id, 'term_legacy')

      const sent = (await send({
        from: 'term_legacy',
        type,
        subject: 'Queued legacy control',
        payload: JSON.stringify({
          taskId: task.id,
          ...(type === 'decision_gate' ? { question: 'Proceed?' } : {})
        })
      })) as { message: { id: string; payload: string } }

      expect(JSON.parse(sent.message.payload)).toMatchObject({ dispatchId: first.id })
      db.failDispatch(first.id, 'worker stopped before coordinator read its mail')
      const second = createRootDispatch(db, task.id, 'term_legacy')

      if (type === 'escalation') {
        applyEscalationToDispatch(db, db.getMessageById(sent.message.id)!, () => {})
      } else {
        openDecisionGateFromMessage(db, db.getMessageById(sent.message.id)!, () => {})
      }

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(second.id)?.status).toBe('dispatched')
      expect(db.listGates({ taskId: task.id })).toHaveLength(0)
    }
  )
})

describe('orchestration.send between terminals in no Run', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('delivers terminal-to-terminal mail when neither terminal is in a Run', async () => {
    // Plain handle-to-handle mail uses the unbound Run; #19542 incorrectly refused it as Run-required.
    const { db, runtime, ctx } = h.setup(false)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_a' ? 'tab_a:leaf_a' : handle === 'term_b' ? 'tab_b:leaf_b' : null
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_a', to: 'term_b', subject: 'hello from no Run' },
      ctx
    )) as { message: { id: string; run_id: string; to_handle: string } }

    expect(result.message).toMatchObject({ run_id: 'run_unbound', to_handle: 'term_b' })
    expect(db.getRun('run_unbound')).toMatchObject({ legacy: 0 })
    expect(db.getUnreadMessages('term_b').map((row) => row.id)).toEqual([result.message.id])
    const checked = (await h.call('orchestration.check', { terminal: 'term_b' }, ctx)) as {
      messages: { id: string }[]
    }
    expect(checked.messages.map((row) => row.id)).toEqual([result.message.id])
  })
})

describe('orchestration.send to a settled Dispatch mailbox', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, ctx } = h.setup())
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it.each([
    ['completed', (settledDb: OrchestrationDb, id: string) => settledDb.completeDispatch(id)],
    [
      'failed',
      (settledDb: OrchestrationDb, id: string) =>
        settledDb.failDispatch(id, 'worker terminal closed')
    ]
  ])('rejects mail to a %s Dispatch instead of reporting success', async (_status, settle) => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    settle(db, dispatch.id)

    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'One more thing'
      })
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  it('names the Run a settled assignee now coordinates, not the sender Run', async () => {
    setup()
    const leadPane = 'tab_lead:22222222-2222-4222-9222-222222222222'
    vi.spyOn(ctx.runtime, 'getLiveTerminalPaneKey').mockReturnValue(leadPane)
    const task = db.createTask({ spec: 'lead that settled and kept coordinating' })
    const dispatch = createRootDispatch(db, task.id, 'term_lead', leadPane)
    db.completeDispatch(dispatch.id)
    const leadRun = db.createRun({
      objective: 'lead',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: leadPane
    })

    const rejection = call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'One more thing'
    })

    await expect(rejection).rejects.toMatchObject({ code: 'dispatch_inactive' })
    await expect(rejection).rejects.toThrow(new RegExp(`run:${leadRun.id}`))
    await expect(rejection).rejects.not.toThrow(new RegExp(`run:${dispatch.run_id}`))
    expect(db.getInbox()).toEqual([])
    await expect(
      call('orchestration.check', { terminal: 'term_coord', run: leadRun.id })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    // Run addresses are already visible to callers; a hint grants no consuming authority.
    expect(await call('orchestration.runShow', { id: leadRun.id })).toMatchObject({
      run: { id: leadRun.id }
    })
  })

  it('does not write an undeliverable message row', async () => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.completeDispatch(dispatch.id)

    await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'One more thing'
    }).catch(() => undefined)

    const stranded = db.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE to_handle = ?')
      .get(`dispatch:${dispatch.id}`) as { count: number }
    expect(stranded.count).toBe(0)
  })
})

describe("orchestration.send: a follow-up's report quoting a Task id", () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb

  afterEach(() => {
    harness.cleanup()
  })

  /** A worker that reported task_first, then took a follow-up Task on the same terminal. */
  function setupFollowUp() {
    const setup = harness.setup()
    db = setup.db
    const first = db.createTask({ spec: 'first assignment' })
    const firstDispatch = createRootDispatch(db, first.id, 'term_worker')
    db.completeDispatch(firstDispatch.id)
    const followUp = db.createTask({ spec: 'follow-up assignment' })
    const followUpDispatch = createRootDispatch(db, followUp.id, 'term_worker')
    db.db
      .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
      .run(firstDispatch.id, followUpDispatch.id)
    const send = (params: Record<string, unknown>) =>
      harness.call('orchestration.send', params, setup.ctx)
    return { first, followUp, followUpDispatch, send }
  }

  const storedPayload = (result: unknown) => {
    const id = z.object({ message: z.object({ id: z.string() }) }).parse(result).message.id
    return z
      .object({ taskId: z.string() })
      .parse(JSON.parse(db.getMessageById(id)?.payload ?? '{}'))
  }

  it("settles the follow-up's Task when worker_done quotes the earlier Task, with a note", async () => {
    const { first, followUp, followUpDispatch, send } = setupFollowUp()

    const result = await send({
      from: 'term_worker',
      type: 'worker_done',
      subject: 'Done',
      payload: JSON.stringify({
        taskId: first.id,
        dispatchId: followUpDispatch.id,
        outcome: 'succeeded'
      })
    })

    expect(result).toMatchObject({
      lifecycle: { action: 'completed', taskId: followUp.id, dispatchId: followUpDispatch.id },
      warnings: [expect.objectContaining({ code: 'stale_task_id' })]
    })
    expect(db.getTask(followUp.id)?.status).toBe('completed')
    expect(storedPayload(result).taskId).toBe(followUp.id)
  })

  it('names the follow-up Task on an escalation that quotes the earlier Task', async () => {
    const { first, followUp, followUpDispatch, send } = setupFollowUp()

    const result = await send({
      from: 'term_worker',
      type: 'escalation',
      subject: 'Blocked',
      payload: JSON.stringify({ taskId: first.id, dispatchId: followUpDispatch.id })
    })

    expect(result).toMatchObject({
      message: { type: 'escalation' },
      warnings: [expect.objectContaining({ code: 'stale_task_id' })]
    })
    expect(result).not.toHaveProperty('lifecycle')
    expect(storedPayload(result).taskId).toBe(followUp.id)
  })

  it('still rejects a worker_done quoting a Task outside its follow-up chain', async () => {
    const { followUp, followUpDispatch, send } = setupFollowUp()
    const unrelated = db.createTask({ spec: 'someone else' })
    createRootDispatch(db, unrelated.id, 'term_other')

    const result = await send({
      from: 'term_worker',
      type: 'worker_done',
      subject: 'Done',
      payload: JSON.stringify({
        taskId: unrelated.id,
        dispatchId: followUpDispatch.id,
        outcome: 'succeeded'
      })
    })

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'task_dispatch_mismatch' }
    })
    expect(db.getTask(followUp.id)?.status).toBe('dispatched')
    expect(db.getTask(unrelated.id)?.status).toBe('dispatched')
  })

  it('settles a matching Task id without a note', async () => {
    const { followUp, followUpDispatch, send } = setupFollowUp()

    const result = await send({
      from: 'term_worker',
      type: 'worker_done',
      subject: 'Done',
      payload: JSON.stringify({
        taskId: followUp.id,
        dispatchId: followUpDispatch.id,
        outcome: 'succeeded'
      })
    })

    expect(result).toMatchObject({ lifecycle: { action: 'completed', taskId: followUp.id } })
    expect(result).not.toHaveProperty('warnings')
  })
})
