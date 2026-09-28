import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { SendParams } from '../schemas'
import { sendRemoteMessage } from './send-remote'
import { sendFederatedControlMail } from './send-control-mail'

describe('per-message notification opt-out', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())
  function setup() {
    const state = h.setup(false)
    vi.spyOn(state.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_a' ? 'tab_a:leaf_a' : handle === 'term_b' ? 'tab_b:leaf_b' : null
    )
    vi.spyOn(state.runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    return state
  }
  const params = { from: 'term_a', to: 'term_b', subject: 'external transport', notify: false }

  it('persists the policy while retaining explicit terminal consumption', async () => {
    const { db, ctx } = setup()
    const result = await h.call('orchestration.send', params, ctx)
    expect(result).toMatchObject({ message: { notify: 0 } })
    expect(db.getUndeliveredUnreadMessages('term_b')).toEqual([])
    const checked = await h.call('orchestration.check', { terminal: 'term_b' }, ctx)
    expect(checked).toMatchObject({ messages: [{ subject: params.subject, notify: 0 }] })
  })
  it('still wakes an explicit blocking check', async () => {
    const { ctx, runtime } = setup()
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage')
    const waiting = h.call(
      'orchestration.check',
      { terminal: 'term_b', wait: true, timeoutMs: 1000 },
      ctx
    )
    await vi.waitFor(() => expect(waitForMessage).toHaveBeenCalled())
    await h.call('orchestration.send', params, ctx)
    expect(await waiting).toMatchObject({
      messages: [{ subject: params.subject, notify: 0 }]
    })
  })
  it('keeps notification disabled when a durable mutation receipt is replayed', async () => {
    const { db, ctx } = setup()
    let receipt: unknown
    ctx.recordMutationReceipt = (value) => {
      receipt = value
    }
    const first = await h.call('orchestration.send', params, ctx)
    ctx.replayedMutationReceipt = receipt
    expect(await h.call('orchestration.send', params, ctx)).toEqual(first)
    expect(db.getUnreadMessages('term_b')).toHaveLength(1)
    expect(db.getUndeliveredUnreadMessages('term_b')).toEqual([])
  })
  it('refuses a federated worker send before queuing a relay', async () => {
    const { db, runtime } = setup()
    const relay = vi.spyOn(db, 'enqueueFederationRelay')
    await expect(
      sendRemoteMessage({
        params,
        db,
        runtime,
        from: 'term_a',
        senderPaneKey: 'tab_a:leaf_a',
        remoteAttachment: { dispatch_id: 'remote', protocol_version: 1 }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(relay).not.toHaveBeenCalled()
  })
  it('refuses coordinator-to-federated-worker mail before queuing a relay', () => {
    const { db, runtime } = setup()
    const relay = vi.spyOn(db, 'enqueueFederationRelay')
    vi.spyOn(db, 'getFederatedDispatch').mockReturnValue({
      dispatch_id: 'remote',
      environment_id: 'env',
      environment_name: 'remote',
      peer_fingerprint: 'peer',
      remote_runtime_epoch: null,
      protocol_version: 1,
      remote_worktree_id: null,
      remote_terminal_handle: null,
      to_home_imported_sequence: 0,
      to_home_acknowledged_sequence: 0,
      created_at: '',
      updated_at: ''
    })
    expect(() =>
      sendFederatedControlMail({
        params,
        db,
        runtime,
        from: 'term_a',
        to: 'dispatch:remote',
        messageRunId: undefined,
        revalidateLegacyCoordinator: undefined,
        recordMutationReceipt: undefined,
        withSendWarnings: (receipt) => receipt
      })
    ).toThrow('notify=false is not supported across federated runtimes.')
    expect(relay).not.toHaveBeenCalled()
  })
  it.each([
    'worker_done',
    'heartbeat',
    'escalation',
    'decision_gate',
    'dispatch',
    'question',
    'merge_ready'
  ])('rejects opt-out for message type %s', (type) => {
    expect(SendParams.safeParse({ subject: 'no', type, notify: false }).success).toBe(false)
  })
  it('rejects opt-out for groups before fan-out', () => {
    expect(SendParams.safeParse({ subject: 'no', to: '@all', notify: false }).success).toBe(false)
  })
  it.each(['status', 'handoff'])('accepts ordinary %s mail', (type) => {
    expect(
      SendParams.safeParse({ subject: 'yes', to: 'term_b', type, notify: false }).success
    ).toBe(true)
  })
})
