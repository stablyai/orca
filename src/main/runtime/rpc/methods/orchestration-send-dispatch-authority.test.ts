import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { openDecisionGateFromMessage } from '../../orchestration/coordinator-decision-gates'
import { applyEscalationToDispatch } from '../../orchestration/coordinator-escalation-triage'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

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
      const attacker = db.createDispatchContext(
        attackerTask.id,
        'term_attacker',
        'tab_attacker:leaf_attacker',
        undefined,
        legacyAuthority ? undefined : 'runtime_test:term_attacker:1'
      )
      const victimTask = db.createTask({ spec: 'victim assignment' })
      const victim = db.createDispatchContext(victimTask.id, 'term_victim')
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
    const dispatch = db.createDispatchContext(task.id, 'term_victim')

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
      db.createDispatchContext(task.id, 'term_legacy')
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
      const first = db.createDispatchContext(task.id, 'term_legacy')

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
      const second = db.createDispatchContext(task.id, 'term_legacy')

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
