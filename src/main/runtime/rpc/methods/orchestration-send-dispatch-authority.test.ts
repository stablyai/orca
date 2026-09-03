import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { openDecisionGateFromMessage } from '../../orchestration/coordinator-decision-gates'
import { applyEscalationToDispatch } from '../../orchestration/coordinator-escalation-triage'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

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
      if (!legacyAuthority) {
        ctx = {
          runtime,
          orchestrationCapability: db.mintDispatchCapability({
            dispatchId: attacker.id,
            paneKey: 'tab_attacker:leaf_attacker',
            processIncarnation: 'runtime_test:term_attacker:1'
          })
        }
      }

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

  // #15634: the capability/pane/incarnation triple identifies a PTY, not the turn
  // running inside it, so anything forked in the worker's pane can settle the
  // Dispatch. Pinned as-is; the same gap applies to heartbeat/escalation/decision_gate,
  // which share this authority path. Closing it needs a single-use turn-scoped
  // credential — an architectural change to capability minting, tracked separately.
  it('documents known trust-granularity limitation: an internal subagent sharing the pane can settle the Dispatch and lock out the owning worker', async () => {
    setup()
    const task = db.createTask({ spec: 'owning worker assignment' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    const identity = {
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1'
    }
    const capability = db.mintDispatchCapability({ dispatchId: dispatch.id, ...identity })
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? identity.paneKey : harness.coordinatorPaneKey
    )
    ctx = { runtime, orchestrationCapability: capability }
    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })

    // Verification is a replayable predicate: the identical triple stays valid across
    // calls, so possession — not turn ownership — is what authorizes a settlement.
    const verifyArgs = { dispatchId: dispatch.id, capability, ...identity }
    expect(db.verifyDispatchCapability(verifyArgs)).toEqual({ valid: true })
    expect(db.verifyDispatchCapability(verifyArgs)).toEqual({ valid: true })

    // The delegated reviewer reports first and is accepted — nothing distinguishes it
    // from the owning turn.
    const subagentReport = (await send({
      from: 'term_worker',
      subject: 'Cold review complete',
      type: 'worker_done',
      payload
    })) as { lifecycle: { action: string } }

    expect(subagentReport.lifecycle).toMatchObject({ action: 'completed' })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')

    // The owning worker — still mid-task — is now locked out of reporting its own result.
    expect(db.verifyDispatchCapability(verifyArgs)).toMatchObject({ valid: false })
    const owningWorkerReport = (await send({
      from: 'term_worker',
      subject: 'Owning worker done',
      type: 'worker_done',
      payload
    })) as { lifecycle: { action: string; code: string }; message: { subject: string } }

    expect(owningWorkerReport.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'dispatch_capability_invalid'
    })
    expect(owningWorkerReport.message.subject).toBe('Rejected worker_done: Owning worker done')
  })
})
