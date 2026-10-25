import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../../../shared/runtime-types'
import { openDecisionGateFromMessage } from '../../../../orchestration/coordinator-decision-gates'
import { applyEscalationToDispatch } from '../../../../orchestration/coordinator-escalation-triage'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

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
})

// The same delivery plumbing `check` already strips; a send/reply receipt is the same mailbox row.
const INTERNAL_COLUMNS = [
  'read',
  'sequence',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation'
]

function terminalSummary(handle: string): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: `pty_${handle}`,
    worktreeId: 'wt_default',
    worktreePath: '/tmp/wt',
    branch: 'main',
    tabId: 'tab_1',
    leafId: handle,
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

describe('orchestration send and reply receipts', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  afterEach(() => h.cleanup())

  function setup(): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup())
  }

  it('keeps delivery plumbing out of a point-to-point send receipt', async () => {
    setup()

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `run:${activeRunId}`, subject: 'plumbing' },
      ctx
    )) as { message: Record<string, unknown> }

    expect(result.message).toMatchObject({ subject: 'plumbing' })
    for (const column of INTERNAL_COLUMNS) {
      expect(result.message).not.toHaveProperty(column)
    }
  })

  it('keeps delivery plumbing out of a group send receipt', async () => {
    setup()
    const terminals = [terminalSummary('term_coord'), terminalSummary('term_worker')]
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals,
      totalCount: terminals.length,
      truncated: false
    })
    createRootDispatch(db, db.createTask({ spec: 'work' }).id, 'term_worker')

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_coord', to: '@all', subject: 'group plumbing' },
      ctx
    )) as { messages: Record<string, unknown>[] }

    expect(result.messages).toHaveLength(1)
    for (const message of result.messages) {
      for (const column of INTERNAL_COLUMNS) {
        expect(message).not.toHaveProperty(column)
      }
    }
  })

  it('keeps delivery plumbing out of a reply receipt', async () => {
    setup()
    const original = db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'Need an answer'
    })

    const result = (await h.call(
      'orchestration.reply',
      { id: original.id, body: 'One durable answer', from: 'term_coord' },
      ctx
    )) as { message: Record<string, unknown> }

    expect(result.message).toMatchObject({ subject: 'Re: Need an answer' })
    for (const column of INTERNAL_COLUMNS) {
      expect(result.message).not.toHaveProperty(column)
    }
  })
})

describe('orchestration.send between terminals in no Run', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('delivers terminal-to-terminal mail when neither terminal is in a Run', async () => {
    // Two plain panes and `send --to <handle>`: the first command the guide teaches. #19542
    // refused this with a bare "Run is required"; it files under the unbound Run instead.
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

  it('names the Run mailbox that is still reachable', async () => {
    setup()
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.completeDispatch(dispatch.id)

    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'One more thing'
      })
    ).rejects.toThrow(new RegExp(`run:${dispatch.run_id}`))
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

  it('still delivers to an active Dispatch mailbox', async () => {
    setup()
    const task = db.createTask({ spec: 'worker still running' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Pause after this step'
    })) as { message: { to_handle: string } }

    expect(result.message.to_handle).toBe(`dispatch:${dispatch.id}`)
  })
})
