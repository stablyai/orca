import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useLiveWorktreeName } from './use-live-worktree-name'

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    }
  }
})

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

describe('useLiveWorktreeName request volume', () => {
  let renderer: ReactTestRenderer | null = null
  let eventListener: ((payload: unknown) => void) | null = null
  const unsubscribeStream = vi.fn()
  const sendRequest = vi.fn().mockResolvedValue({
    id: 'worktree-show',
    ok: true,
    result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
    _meta: { runtimeId: 'runtime-1' }
  })
  const subscribe = vi.fn(
    (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
      eventListener = listener
      return unsubscribeStream
    }
  )
  const client = { sendRequest, subscribe } as unknown as RpcClient

  async function mountHarness(): Promise<void> {
    function Harness(): null {
      useLiveWorktreeName({
        client,
        connState: 'connected',
        routeName: 'Route name',
        worktreeId: 'repo-1::/worktree'
      })
      return null
    }

    const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
        await Promise.resolve()
      })
    } finally {
      restoreConsoleError()
    }
  }

  async function emitEvent(payload: unknown): Promise<void> {
    await act(async () => {
      eventListener?.(payload)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    eventListener = null
    sendRequest.mockClear().mockResolvedValue({
      id: 'worktree-show',
      ok: true,
      result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    subscribe.mockClear()
    unsubscribeStream.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('cuts thirty-second idle request volume from eleven calls to one', async () => {
    await mountHarness()
    expect(subscribe).toHaveBeenCalledWith(
      'runtime.clientEvents.subscribe',
      null,
      expect.any(Function)
    )
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    // The retired 3s interval made one initial request plus ten idle ticks here.
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await emitEvent({ type: 'worktreesChanged', repoId: 'repo-2' })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await emitEvent({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(sendRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps polling when an older runtime rejects the event stream', async () => {
    await mountHarness()
    await emitEvent({ type: 'error', message: 'Unknown method' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })

    expect(sendRequest).toHaveBeenCalledTimes(4)
  })

  it('retries a failed initial read even after the event stream is ready', async () => {
    sendRequest.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({
      id: 'worktree-show',
      ok: true,
      result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    await mountHarness()
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('refreshes once when a reconnected stream becomes ready again', async () => {
    await mountHarness()
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-2' })

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes when the screen loses focus', async () => {
    await mountHarness()
    act(() => renderer?.unmount())
    renderer = null

    expect(unsubscribeStream).toHaveBeenCalledTimes(1)
  })
})
