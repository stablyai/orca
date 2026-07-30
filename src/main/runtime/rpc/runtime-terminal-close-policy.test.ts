import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { RuntimeClosePolicy } from './runtime-close-policy'
import type { RuntimeCloseIntent } from '../../../shared/runtime-close-intent'

function request(id: string, method: string, params?: unknown): RpcRequest {
  return { id, authToken: 'token', method, params }
}

function runtimeStub(): OrcaRuntimeService {
  const created = {
    handle: 'created-terminal',
    tabId: 'created-tab',
    worktreeId: 'wt-1',
    title: null
  }
  return {
    getRuntimeId: () => 'runtime-test',
    // Why: main routes create through dedupeTerminalCreate; the factory still
    // needs a createTerminal implementation for other paths.
    createTerminal: vi.fn().mockResolvedValue(created),
    dedupeTerminalCreate: vi.fn(
      async (
        _clientKey: string,
        _worktree: string | undefined,
        _clientMutationId: string | undefined,
        _reconcileExisting: boolean,
        create: (
          canonicalWorktreeSelector?: string,
          preAllocatedHandle?: string
        ) => Promise<unknown>
      ) => create(undefined, undefined)
    ),
    closeTerminal: vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      tabId: 'tab-1',
      ptyKilled: true
    }),
    closeTerminalTab: vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      tabId: 'tab-1',
      closeMode: 'tab',
      ptyKilled: false
    })
  } as unknown as OrcaRuntimeService
}

async function call(
  dispatcher: RpcDispatcher,
  rpcRequest: RpcRequest,
  options: { connectionId: string; deviceId: string; clientKind: 'runtime' | 'mobile' }
): Promise<Record<string, unknown>> {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(rpcRequest, (reply) => replies.push(reply), options)
  return JSON.parse(replies[0]!) as Record<string, unknown>
}

function userCloseIntent(overrides: Partial<RuntimeCloseIntent> = {}): RuntimeCloseIntent {
  return {
    source: 'user-pane-close',
    userInitiated: true,
    requestId: 'close-request-1',
    occurredAt: Date.now(),
    worktreeId: 'wt-1',
    clientTabId: 'mirror-tab-1',
    ptyOrHandle: 'terminal-1',
    ...overrides
  }
}

const RUNTIME_CLIENT = {
  connectionId: 'runtime-connection',
  deviceId: 'runtime-device',
  clientKind: 'runtime' as const
}

describe('runtime terminal close policy', () => {
  it.each(['terminal.close', 'terminal.closeTab'])(
    'soft-denies legacy %s requests',
    async (method) => {
      const runtime = runtimeStub()
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const response = await call(
        dispatcher,
        request('req-1', method, { terminal: 'terminal-1' }),
        RUNTIME_CLIENT
      )

      expect(runtime.closeTerminal).not.toHaveBeenCalled()
      expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
      expect(response).toMatchObject({
        ok: true,
        result: { close: { ptyKilled: false, blockedReason: 'close_intent_required' } }
      })
    }
  )

  it('does not record a scrollback-only terminal read as a live attachment', async () => {
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['disconnected'], truncated: false })
    } as unknown as OrcaRuntimeService
    const runtimeClosePolicy = new RuntimeClosePolicy()
    const recordAttachedTarget = vi.spyOn(runtimeClosePolicy, 'recordAttachedTarget')
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS,
      runtimeClosePolicy
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      request('req-subscribe', 'terminal.subscribe', { terminal: 'terminal-1' }),
      (reply) => replies.push(reply),
      RUNTIME_CLIENT
    )

    expect(recordAttachedTarget).not.toHaveBeenCalled()
    expect(replies.map((reply) => JSON.parse(reply).result)).toEqual([
      expect.objectContaining({ type: 'subscribed', streamId: null }),
      { type: 'end' }
    ])
  })

  it('allows an explicit user close whose target matches the RPC', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await call(
      dispatcher,
      request('req-1', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent()
      }),
      RUNTIME_CLIENT
    )

    expect(runtime.closeTerminal).toHaveBeenCalledWith('terminal-1')
    expect(response).toMatchObject({ ok: true, result: { close: { ptyKilled: true } } })
  })

  it('rejects malformed close intent at the RPC schema boundary', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const { requestId: _requestId, ...missingRequestId } = userCloseIntent()

    const response = await call(
      dispatcher,
      request('req-invalid', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: missingRequestId
      }),
      RUNTIME_CLIENT
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('preserves legacy mobile close behavior', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await call(
      dispatcher,
      request('req-mobile', 'terminal.close', { terminal: 'terminal-1' }),
      { connectionId: 'mobile-connection', deviceId: 'mobile-device', clientKind: 'mobile' }
    )

    expect(runtime.closeTerminal).toHaveBeenCalledWith('terminal-1')
    expect(response).toMatchObject({ ok: true, result: { close: { ptyKilled: true } } })
  })

  it('blocks mismatched and duplicate close intents', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const mismatch = await call(
      dispatcher,
      request('req-mismatch', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent({ ptyOrHandle: 'other-terminal' })
      }),
      RUNTIME_CLIENT
    )
    const first = await call(
      dispatcher,
      request('req-first', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent()
      }),
      RUNTIME_CLIENT
    )
    const duplicate = await call(
      dispatcher,
      request('req-duplicate', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent()
      }),
      { ...RUNTIME_CLIENT, connectionId: 'runtime-reconnected' }
    )

    expect(mismatch).toMatchObject({
      result: { close: { blockedReason: 'close_intent_mismatch' } }
    })
    expect(first).toMatchObject({ result: { close: { ptyKilled: true } } })
    expect(duplicate).toMatchObject({
      result: { close: { blockedReason: 'close_intent_duplicate' } }
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('allows rollback only for a terminal created by the same runtime connection', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await call(
      dispatcher,
      request('req-create', 'terminal.create', { worktree: 'id:wt-1' }),
      RUNTIME_CLIENT
    )
    const rollbackIntent = {
      source: 'client-created-rollback',
      userInitiated: false,
      requestId: 'rollback-request-1',
      occurredAt: Date.now(),
      worktreeId: 'wt-1',
      clientTabId: 'mirror-tab-1',
      ptyOrHandle: 'created-terminal'
    }
    const forged = await call(
      dispatcher,
      request('req-forged', 'terminal.close', {
        terminal: 'created-terminal',
        closeIntent: { ...rollbackIntent, requestId: 'rollback-forged' }
      }),
      { ...RUNTIME_CLIENT, connectionId: 'other-connection' }
    )
    const owned = await call(
      dispatcher,
      request('req-owned', 'terminal.close', {
        terminal: 'created-terminal',
        closeIntent: rollbackIntent
      }),
      RUNTIME_CLIENT
    )

    expect(forged).toMatchObject({
      result: { close: { blockedReason: 'close_rollback_not_owned' } }
    })
    expect(owned).toMatchObject({ result: { close: { ptyKilled: true } } })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('denies a creation-ownership rollback through terminal.closeTab', async () => {
    // Why: closeTab destroys sibling panes the creating connection never owned,
    // so rollback authority stays scoped to plain terminal.close.
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await call(
      dispatcher,
      request('req-create', 'terminal.create', { worktree: 'id:wt-1' }),
      RUNTIME_CLIENT
    )
    const escalated = await call(
      dispatcher,
      request('req-close-tab', 'terminal.closeTab', {
        terminal: 'created-terminal',
        closeIntent: {
          source: 'client-created-rollback',
          userInitiated: false,
          requestId: 'rollback-close-tab',
          occurredAt: Date.now(),
          worktreeId: 'wt-1',
          ptyOrHandle: 'created-terminal'
        }
      }),
      RUNTIME_CLIENT
    )

    expect(escalated).toMatchObject({
      result: { close: { blockedReason: 'close_rollback_not_owned' } }
    })
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('spends the per-device rate budget on owned rollbacks', async () => {
    const now = 1_000_000
    const policy = new RuntimeClosePolicy({
      now: () => now,
      maxClosesPerWindow: 1
    })
    policy.recordTerminalCreated(RUNTIME_CLIENT, 'terminal-owned')
    policy.recordTerminalCreated(RUNTIME_CLIENT, 'terminal-owned-2')

    const rollbackIntent = (terminal: string, requestId: string): RuntimeCloseIntent => ({
      source: 'client-created-rollback',
      userInitiated: false,
      requestId,
      occurredAt: now,
      worktreeId: 'wt-1',
      ptyOrHandle: terminal
    })

    expect(
      policy.evaluate(
        RUNTIME_CLIENT,
        { kind: 'terminal', terminal: 'terminal-owned' },
        rollbackIntent('terminal-owned', 'rollback-first')
      )
    ).toMatchObject({ allowed: true, reason: 'owned-rollback' })
    expect(
      policy.evaluate(
        RUNTIME_CLIENT,
        { kind: 'terminal', terminal: 'terminal-owned-2' },
        rollbackIntent('terminal-owned-2', 'rollback-second')
      )
    ).toMatchObject({ allowed: false, reason: 'close_rate_limited' })
  })

  it('rate-limits explicit destructive requests per runtime connection', async () => {
    const runtime = runtimeStub()
    const now = 1_000_000
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS,
      runtimeClosePolicy: new RuntimeClosePolicy({
        now: () => now,
        maxClosesPerWindow: 1
      })
    })

    const first = await call(
      dispatcher,
      request('req-first', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent({ requestId: 'rate-1', occurredAt: now })
      }),
      RUNTIME_CLIENT
    )
    const limited = await call(
      dispatcher,
      request('req-limited', 'terminal.close', {
        terminal: 'terminal-1',
        closeIntent: userCloseIntent({ requestId: 'rate-2', occurredAt: now })
      }),
      RUNTIME_CLIENT
    )

    expect(first).toMatchObject({ result: { close: { ptyKilled: true } } })
    expect(limited).toMatchObject({
      result: { close: { blockedReason: 'close_rate_limited' } }
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('shares the rate budget across connections of one device but not across devices', async () => {
    const now = 1_000_000
    const policy = new RuntimeClosePolicy({
      now: () => now,
      maxClosesPerWindow: 1
    })
    const target = { kind: 'terminal' as const, terminal: 'terminal-1' }
    const sameDeviceOtherConnection = { ...RUNTIME_CLIENT, connectionId: 'runtime-connection-2' }
    const otherDevice = { ...RUNTIME_CLIENT, deviceId: 'other-device' }

    expect(
      policy.evaluate(RUNTIME_CLIENT, target, userCloseIntent({ requestId: 'budget-1' }))
    ).toMatchObject({ allowed: true })
    expect(
      policy.evaluate(sameDeviceOtherConnection, target, userCloseIntent({ requestId: 'budget-2' }))
    ).toMatchObject({ allowed: false, reason: 'close_rate_limited' })
    expect(
      policy.evaluate(otherDevice, target, userCloseIntent({ requestId: 'budget-3' }))
    ).toMatchObject({ allowed: true })
  })

  it('does not evict another runtime actor replay record at per-actor capacity', () => {
    const now = 1_000_000
    const policy = new RuntimeClosePolicy({
      now: () => now,
      maxTrackedEntriesPerActor: 1
    })
    const target = { kind: 'terminal' as const, terminal: 'terminal-1' }
    const otherRuntime = {
      ...RUNTIME_CLIENT,
      connectionId: 'other-connection',
      deviceId: 'other-device'
    }

    expect(
      policy.evaluate(RUNTIME_CLIENT, target, userCloseIntent({ requestId: 'first' }))
    ).toEqual({
      allowed: true,
      reason: 'explicit-user',
      recentlyAttached: false
    })
    expect(
      policy.evaluate(RUNTIME_CLIENT, target, userCloseIntent({ requestId: 'at-capacity' }))
    ).toMatchObject({ allowed: false, reason: 'close_rate_limited' })
    expect(
      policy.evaluate(otherRuntime, target, userCloseIntent({ requestId: 'other-actor' }))
    ).toMatchObject({ allowed: true })
    expect(
      policy.evaluate(RUNTIME_CLIENT, target, userCloseIntent({ requestId: 'first' }))
    ).toEqual({
      allowed: false,
      reason: 'close_intent_duplicate',
      recentlyAttached: false
    })
  })

  it('keeps unexpired rollback ownership when the same actor reaches capacity', () => {
    const now = 1_000_000
    const policy = new RuntimeClosePolicy({
      now: () => now,
      maxTrackedEntriesPerActor: 1
    })
    const rollbackIntent = (terminal: string, requestId: string): RuntimeCloseIntent => ({
      source: 'client-created-rollback',
      userInitiated: false,
      requestId,
      occurredAt: now,
      worktreeId: 'wt-1',
      clientTabId: 'mirror-tab-1',
      ptyOrHandle: terminal
    })

    policy.recordTerminalCreated(RUNTIME_CLIENT, 'terminal-owned')
    policy.recordTerminalCreated(RUNTIME_CLIENT, 'terminal-over-capacity')

    expect(
      policy.evaluate(
        { ...RUNTIME_CLIENT, deviceId: 'over-capacity-device' },
        { kind: 'terminal', terminal: 'terminal-over-capacity' },
        rollbackIntent('terminal-over-capacity', 'rollback-over-capacity')
      )
    ).toMatchObject({ allowed: false, reason: 'close_rollback_not_owned' })
    expect(
      policy.evaluate(
        { ...RUNTIME_CLIENT, deviceId: 'owned-device' },
        { kind: 'terminal', terminal: 'terminal-owned' },
        rollbackIntent('terminal-owned', 'rollback-owned')
      )
    ).toMatchObject({ allowed: true, reason: 'owned-rollback' })
  })

  it('blocks lifecycle-only intent while retaining recent-attach evidence', () => {
    const now = 1_000_000
    const policy = new RuntimeClosePolicy({ now: () => now })
    const target = { kind: 'terminal' as const, terminal: 'terminal-1' }
    policy.recordAttachedTarget(RUNTIME_CLIENT, target)

    expect(policy.evaluate(RUNTIME_CLIENT, target)).toEqual({
      allowed: false,
      reason: 'close_intent_required',
      recentlyAttached: true
    })
    expect(
      policy.evaluate(
        RUNTIME_CLIENT,
        target,
        userCloseIntent({
          source: 'lifecycle-cleanup',
          userInitiated: false,
          requestId: 'lifecycle',
          occurredAt: now
        })
      )
    ).toEqual({
      allowed: false,
      reason: 'close_source_not_allowed',
      recentlyAttached: true
    })
  })
})
