import { describe, expect, it, vi } from 'vitest'
import { subscribeRuntimeClientEvents } from './runtime-client-events'

describe('subscribeRuntimeClientEvents', () => {
  it('subscribes to runtime client events and forwards event frames', async () => {
    const unsubscribe = vi.fn()
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe, sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    const onError = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { subscribe }
      }
    })

    const subscription = await subscribeRuntimeClientEvents('env-1', onEvent, onError)

    expect(subscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'runtime.clientEvents.subscribe',
        timeoutMs: 15_000
      },
      expect.objectContaining({
        onResponse: expect.any(Function),
        onError
      })
    )

    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }
    // Regression: runtime.clientEvents.subscribe is a StreamHandler channel
    // (registry.go) — its plain invoke ack carries result:null, delivered to
    // onResponse too (isSubscriptionResponse widened for FE-TASK-EVM-002's
    // subscribeRuntimeStreamChannel). Used to throw reading message.type on
    // that null (found live on b15.openledger.vn, 2026-09-08).
    expect(() => capturedOnResponse?.({ ok: true, result: null })).not.toThrow()
    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' }
    })
    capturedOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' }
    })
    capturedOnResponse({
      ok: false,
      error: { code: 'method_not_found', message: 'missing' }
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(onError).toHaveBeenCalledWith({ code: 'method_not_found', message: 'missing' })

    subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('signals a replay-tagged response so event-derived state can resync after a reconnect', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    const onReplayed = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { subscribe }
      }
    })

    await subscribeRuntimeClientEvents('env-1', onEvent, vi.fn(), onReplayed)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }

    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' }
    })
    expect(onReplayed).not.toHaveBeenCalled()

    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' },
      _replayedAfterReconnect: true
    })
    expect(onReplayed).toHaveBeenCalledTimes(1)

    // A replay-tagged event frame both signals and still delivers the event.
    capturedOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' },
      _replayedAfterReconnect: true
    })
    expect(onReplayed).toHaveBeenCalledTimes(2)
    expect(onEvent).toHaveBeenCalledWith({ type: 'worktreesChanged', repoId: 'repo-1' })
  })
})
