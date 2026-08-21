import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext, RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

type SendWarning = { code: string; recipient: string; message: string }
type SendResult = {
  message: { id: string; run_id: string; to_handle: string }
  warnings?: SendWarning[]
}
type GroupSendResult = {
  messages: { id: string; run_id: string; to_handle: string }[]
  recipients: number
  warnings?: SendWarning[]
}

describe('orchestration recipient routing oracle', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let senderRunId: string

  function setup(): void {
    const state = harness.setup()
    db = state.db
    runtime = state.runtime
    ctx = state.ctx
    senderRunId = state.activeRunId!
  }

  async function call(params: Record<string, unknown>): Promise<unknown> {
    return harness.call('orchestration.send', params, ctx)
  }

  function mockTerminalPaneKeys(resolve: (handle: string) => string | null): void {
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation(resolve)
    vi.mocked(runtime.getLiveTerminalPaneKey).mockImplementation(resolve)
  }

  afterEach(() => harness.cleanup())

  it('rejects an unknown terminal without creating an unread row', async () => {
    setup()

    await expect(
      call({ from: 'term_coord', to: 'term_invented', subject: 'unreachable' })
    ).rejects.toMatchObject({ code: 'terminal_not_found' })
    expect(db.getInbox(100)).toEqual([])
  })

  it('rejects a closed terminal that has no durable mailbox owner', async () => {
    setup()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('retained-pty-record')

    await expect(
      call({ from: 'term_coord', to: 'term_closed', subject: 'closed' })
    ).rejects.toMatchObject({ code: 'terminal_not_found' })
    expect(db.getInbox(100)).toEqual([])
  })

  it('keeps a live terminal-only recipient readable and reports its delivery limitation', async () => {
    setup()
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_live'
          ? 'tab_live:leaf_live'
          : null
    )

    const result = (await call({
      from: 'term_coord',
      to: 'term_live',
      subject: 'compatibility'
    })) as SendResult

    expect(result).toMatchObject({
      message: { run_id: senderRunId, to_handle: 'term_live' },
      warnings: [{ code: 'legacy_terminal_recipient', recipient: 'term_live' }]
    })
    const check = (await harness.call(
      'orchestration.check',
      { terminal: 'term_live', peek: true },
      ctx
    )) as {
      messages: { id: string }[]
    }
    expect(check.messages.map((message) => message.id)).toEqual([result.message.id])
  })

  it('normalizes a cross-Run coordinator handle to the recipient Run mailbox', async () => {
    setup()
    const recipientPane = 'tab_recipient:leaf_recipient'
    const recipientRun = db.createRun({
      objective: 'Recipient Run',
      coordinatorHandle: 'term_recipient',
      coordinatorPaneKey: recipientPane
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_recipient'
          ? recipientPane
          : null
    )

    const result = (await call({
      from: 'term_coord',
      to: 'term_recipient',
      subject: 'cross-run'
    })) as SendResult

    expect(result.message).toMatchObject({
      run_id: recipientRun.id,
      to_handle: `run:${recipientRun.id}`
    })
    const check = (await harness.call(
      'orchestration.check',
      { terminal: 'term_recipient', peek: true },
      ctx
    )) as { messages: { id: string }[] }
    expect(check.messages.map((message) => message.id)).toEqual([result.message.id])
  })

  it('never lets a stale leaf handle adopt its replacement pane Run', async () => {
    setup()
    const staleOwner = db.createRun({
      objective: 'Original pane owner',
      coordinatorHandle: 'term_stale',
      coordinatorPaneKey: 'tab_original:leaf_shared'
    })
    const replacement = db.createRun({
      objective: 'Replacement pane owner',
      coordinatorHandle: 'term_replacement',
      coordinatorPaneKey: 'tab_replacement:leaf_shared'
    })
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_stale' || handle === 'term_unowned_stale'
          ? 'tab_replacement:leaf_shared'
          : null
    )
    vi.mocked(runtime.getLiveTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? harness.coordinatorPaneKey : null
    )

    const routed = (await call({
      from: 'term_coord',
      to: 'term_stale',
      subject: 'historical owner'
    })) as SendResult

    expect(routed.message).toMatchObject({
      run_id: staleOwner.id,
      to_handle: `run:${staleOwner.id}`
    })
    expect(routed.message.run_id).not.toBe(replacement.id)
    await expect(
      call({ from: 'term_coord', to: 'term_unowned_stale', subject: 'no owner' })
    ).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('normalizes an active Dispatch owner even when no pane is live', async () => {
    setup()
    const task = db.createTask({ spec: 'detached worker' })
    const dispatch = db.createDispatchContext(task.id, 'term_detached', 'tab_gone:leaf_gone')

    const result = (await call({
      from: 'term_coord',
      to: 'term_detached',
      subject: 'wait durably'
    })) as SendResult

    expect(result.message).toMatchObject({
      run_id: senderRunId,
      to_handle: `dispatch:${dispatch.id}`
    })
    expect(result.warnings).toBeUndefined()
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toHaveLength(1)
  })

  it('reports an explicit Run mismatch for one detached Dispatch owner', async () => {
    setup()
    const foreignRun = db.createRun({
      objective: 'Foreign worker Run',
      coordinatorHandle: 'term_foreign_coord',
      coordinatorPaneKey: 'tab_foreign:leaf_coord'
    })
    const task = db.createTask({ spec: 'detached foreign worker', runId: foreignRun.id })
    db.createDispatchContext(task.id, 'term_detached_foreign', 'tab_gone:leaf_gone')

    await expect(
      call({
        from: 'term_coord',
        to: 'term_detached_foreign',
        run: senderRunId,
        subject: 'wrong Run'
      })
    ).rejects.toMatchObject({ code: 'recipient_run_mismatch' })
    expect(db.getInbox(100)).toEqual([])
  })

  it('matches check precedence when a live Run coordinator pane overlaps a Dispatch', async () => {
    setup()
    const overlapPane = 'tab_overlap:leaf_overlap'
    const task = db.createTask({ spec: 'overlapped worker' })
    db.createDispatchContext(task.id, 'term_overlap', overlapPane)
    const recipientRun = db.createRun({
      objective: 'Overlapping coordinator',
      coordinatorHandle: 'term_overlap',
      coordinatorPaneKey: overlapPane
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_overlap'
          ? overlapPane
          : null
    )

    const result = (await call({
      from: 'term_coord',
      to: 'term_overlap',
      subject: 'same read path'
    })) as SendResult

    expect(result.message).toMatchObject({
      run_id: recipientRun.id,
      to_handle: `run:${recipientRun.id}`
    })
    const check = (await harness.call(
      'orchestration.check',
      { terminal: 'term_overlap', peek: true },
      ctx
    )) as { messages: { id: string }[] }
    expect(check.messages.map((message) => message.id)).toEqual([result.message.id])
  })

  it('keeps same-Run historical coordinator routing from the canonical mailbox change', async () => {
    setup()
    db.bindRun({
      runId: senderRunId,
      coordinatorHandle: 'term_current',
      coordinatorPaneKey: 'tab_current:leaf_current'
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_current' ? 'tab_current:leaf_current' : null
    )

    const result = (await call({
      from: 'term_current',
      to: 'term_coord',
      subject: 'historical'
    })) as SendResult

    expect(result.message.to_handle).toBe(`run:${senderRunId}`)
    expect(result.warnings).toBeUndefined()
  })

  it('rejects a historical handle that names more than one foreign Run', async () => {
    setup()
    db.createRun({
      objective: 'First owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_first:leaf_first'
    })
    db.createRun({
      objective: 'Second owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_second:leaf_second'
    })

    await expect(
      call({ from: 'term_coord', to: 'term_ambiguous', subject: 'ambiguous' })
    ).rejects.toMatchObject({ code: 'recipient_ambiguous' })
    expect(db.getInbox(100)).toEqual([])
  })

  it.each(['@all', '@worktree:wt_target'])(
    'partially delivers %s when a listed recipient disappears before routing',
    async (address) => {
      setup()
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
        terminals: [terminal('term_coord'), terminal('term_live'), terminal('term_disappeared')],
        totalCount: 3,
        truncated: false
      })
      mockTerminalPaneKeys((handle) =>
        handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : handle === 'term_live'
            ? 'tab_live:leaf_live'
            : null
      )
      const adoptionLookup = vi.spyOn(db, 'getLegacyAdoptedRunMailboxOwner')

      const result = (await call({
        from: 'term_coord',
        to: address,
        subject: 'fan-out'
      })) as GroupSendResult

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toMatchObject({ to_handle: 'term_live' })
      expect(result.recipients).toBe(1)
      expect(result.warnings?.map((warning) => warning.code).sort()).toEqual([
        'legacy_terminal_recipient',
        'recipient_unreachable'
      ])
      expect(db.getInbox(100)).toHaveLength(1)
      expect(adoptionLookup).toHaveBeenCalledTimes(1)
    }
  )

  it('fans out once when historical handles resolve to the same Run mailbox', async () => {
    setup()
    const foreignRun = db.createRun({
      objective: 'Foreign Run',
      coordinatorHandle: 'term_foreign_first',
      coordinatorPaneKey: 'tab_foreign_first:leaf_foreign_first'
    })
    db.bindRun({
      runId: foreignRun.id,
      coordinatorHandle: 'term_foreign_second',
      coordinatorPaneKey: 'tab_foreign_second:leaf_foreign_second'
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal('term_coord'),
        terminal('term_foreign_first'),
        terminal('term_foreign_second')
      ],
      totalCount: 3,
      truncated: false
    })
    mockTerminalPaneKeys((handle) => (handle === 'term_coord' ? harness.coordinatorPaneKey : null))

    const result = (await call({
      from: 'term_coord',
      to: '@all',
      subject: 'one mailbox'
    })) as GroupSendResult

    expect(result.recipients).toBe(1)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      run_id: foreignRun.id,
      to_handle: `run:${foreignRun.id}`
    })
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('excludes historical handles that resolve back to the sender mailbox', async () => {
    setup()
    db.bindRun({
      runId: senderRunId,
      coordinatorHandle: 'term_middle',
      coordinatorPaneKey: 'tab_middle:leaf_middle'
    })
    db.bindRun({
      runId: senderRunId,
      coordinatorHandle: 'term_sender',
      coordinatorPaneKey: 'tab_sender:leaf_sender'
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal('term_sender'),
        terminal('term_coord'),
        terminal('term_middle'),
        terminal('term_live')
      ],
      totalCount: 4,
      truncated: false
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_sender'
        ? 'tab_sender:leaf_sender'
        : handle === 'term_live'
          ? 'tab_live:leaf_live'
          : null
    )

    const result = (await call({
      from: 'term_sender',
      to: '@all',
      subject: 'exclude self aliases'
    })) as GroupSendResult

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].to_handle).toBe('term_live')
    expect(result.warnings).toMatchObject([{ code: 'legacy_terminal_recipient' }])
  })

  it('replays one honest receipt and discards retry receipts for rejected recipients', async () => {
    setup()
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_live'
          ? 'tab_live:leaf_live'
          : null
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const rejected = request('rpc_reject_1', 'retry_reject', 'term_missing')

    const firstRejected = await dispatcher.dispatch(rejected)
    const retriedRejected = await dispatcher.dispatch({ ...rejected, id: 'rpc_reject_2' })
    expect(firstRejected).toMatchObject({ ok: false, error: { code: 'terminal_not_found' } })
    expect(retriedRejected).toMatchObject({ ok: false, error: { code: 'terminal_not_found' } })
    expect(db.getInbox(100)).toEqual([])
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    expect(db.getMutationReceipt(callerFingerprint, 'retry_reject')).toBeUndefined()

    const accepted = request('rpc_accept_1', 'retry_accept', 'term_live')
    const firstAccepted = await dispatcher.dispatch(accepted)
    const replayed = await dispatcher.dispatch({ ...accepted, id: 'rpc_accept_2' })
    expect(firstAccepted).toMatchObject({
      ok: true,
      result: {
        message: { id: expect.stringMatching(/^msg_/) },
        warnings: [{ code: 'legacy_terminal_recipient' }],
        mutation: { requestId: 'retry_accept', replayed: false }
      }
    })
    expect(replayed).toMatchObject({
      ok: true,
      result: {
        message: { id: firstAccepted.ok ? (firstAccepted.result as SendResult).message.id : '' },
        warnings: [{ code: 'legacy_terminal_recipient' }],
        mutation: { requestId: 'retry_accept', replayed: true }
      }
    })
    expect(db.getInbox(100)).toHaveLength(1)
    expect(db.getMutationReceipt(callerFingerprint, 'retry_accept')).toMatchObject({
      state: 'completed',
      receipt: expect.stringContaining('legacy_terminal_recipient')
    })
  })

  it('serializes ambiguity and explicit Run mismatch through the RPC boundary', async () => {
    setup()
    db.createRun({
      objective: 'First owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_first:leaf_first'
    })
    db.createRun({
      objective: 'Second owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_second:leaf_second'
    })
    const foreignRun = db.createRun({
      objective: 'Foreign owner',
      coordinatorHandle: 'term_foreign',
      coordinatorPaneKey: 'tab_foreign:leaf_foreign'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    const ambiguous = await dispatcher.dispatch(
      request('rpc_ambiguous', 'retry_ambiguous', 'term_ambiguous')
    )
    const mismatch = await dispatcher.dispatch(
      request('rpc_mismatch', 'retry_mismatch', 'term_foreign', { run: senderRunId })
    )

    expect(ambiguous).toMatchObject({ ok: false, error: { code: 'recipient_ambiguous' } })
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'recipient_run_mismatch' } })
    expect(foreignRun.id).not.toBe(senderRunId)
    expect(db.getInbox(100)).toEqual([])
  })

  it('rolls back a partial group insert before an idempotent retry', async () => {
    setup()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal('term_coord'), terminal('term_first'), terminal('term_second')],
      totalCount: 3,
      truncated: false
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_first'
          ? 'tab_first:leaf_first'
          : handle === 'term_second'
            ? 'tab_second:leaf_second'
            : null
    )
    const insertMessage = db.insertMessage.bind(db)
    vi.spyOn(db, 'insertMessage')
      .mockImplementationOnce(insertMessage)
      .mockImplementationOnce(() => {
        throw new Error('injected second insert failure')
      })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const group = request('rpc_group_partial', 'retry_group_partial', '@all')

    const failed = await dispatcher.dispatch(group)
    expect(failed.ok).toBe(false)
    expect(db.getInbox(100)).toEqual([])

    const retried = await dispatcher.dispatch({ ...group, id: 'rpc_group_partial_retry' })
    expect(retried).toMatchObject({
      ok: true,
      result: { messages: [{ id: expect.any(String) }, { id: expect.any(String) }] }
    })
    expect(db.getInbox(100)).toHaveLength(2)
  })

  it('replays a completed group receipt when notification fails after durable insertion', async () => {
    setup()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal('term_coord'), terminal('term_live')],
      totalCount: 2,
      truncated: false
    })
    mockTerminalPaneKeys((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === 'term_live'
          ? 'tab_live:leaf_live'
          : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementationOnce(() => {
      throw new Error('injected notification failure')
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const group = request('rpc_group_notify', 'retry_group_notify', '@all')

    const failed = await dispatcher.dispatch(group)
    const retried = await dispatcher.dispatch({ ...group, id: 'rpc_group_notify_retry' })

    expect(failed.ok).toBe(false)
    expect(retried).toMatchObject({
      ok: true,
      result: {
        messages: [{ id: expect.any(String) }],
        mutation: { requestId: 'retry_group_notify', replayed: true }
      }
    })
    expect(db.getInbox(100)).toHaveLength(1)
  })
})

function terminal(handle: string): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: handle,
    worktreeId: 'wt_target',
    worktreePath: '/workspace',
    branch: 'main',
    tabId: `tab_${handle}`,
    leafId: `leaf_${handle}`,
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

function request(
  id: string,
  requestId: string,
  to: string,
  extraParams: Record<string, unknown> = {}
): RpcRequest {
  return {
    id,
    authToken: 'test-token',
    method: 'orchestration.send',
    params: { from: 'term_coord', to, subject: 'retry', ...extraParams },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId
  }
}
