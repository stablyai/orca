import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import { waitForRpcClientReconnected } from './rpc-client-reconnect-wait'

// Allow synchronous state notification during registration to exercise unsubscribe assignment races.
function fakeClient(
  initial: ConnectionState,
  options: { notifyDuringSubscribe?: ConnectionState } = {}
): { client: RpcClient; set: (next: ConnectionState) => void; listenerCount: () => number } {
  let state = initial
  const listeners = new Set<(next: ConnectionState) => void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The wait owner only reads getState and registers onStateChange on this fixture.
  const client = {
    getState: () => state,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      if (options.notifyDuringSubscribe) {
        state = options.notifyDuringSubscribe
        listener(state)
      }
      return () => listeners.delete(listener)
    }
  } as unknown as RpcClient
  return {
    client,
    set: (next) => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    listenerCount: () => listeners.size
  }
}

describe('waitForRpcClientReconnected', () => {
  it('resolves immediately when the transport is already connected', async () => {
    const { client, listenerCount } = fakeClient('connected')
    await expect(waitForRpcClientReconnected(client, 10_000)).resolves.toBe(true)
    expect(listenerCount()).toBe(0)
  })

  it('resolves once the transport comes back, and unsubscribes', async () => {
    vi.useFakeTimers()
    try {
      const { client, set, listenerCount } = fakeClient('reconnecting')
      const pending = waitForRpcClientReconnected(client, 10_000)
      expect(listenerCount()).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      set('connected')
      await expect(pending).resolves.toBe(true)
      expect(listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up at the timeout and unsubscribes', async () => {
    vi.useFakeTimers()
    try {
      const { client, listenerCount } = fakeClient('reconnecting')
      const pending = waitForRpcClientReconnected(client, 10_000)
      const settled = vi.fn()
      void pending.then(settled)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).not.toHaveBeenCalled()
      expect(listenerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toBe(false)
      expect(listenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    // Virtual-time advancement yields real macrotasks; allow loaded runners more wall-clock time.
  }, 30_000)

  it('does not wait out the timeout when the pairing is already revoked', async () => {
    const { client, listenerCount } = fakeClient('auth-failed')
    await expect(waitForRpcClientReconnected(client, 10_000)).resolves.toBe(false)
    expect(listenerCount()).toBe(0)
  })

  it('does not wait out the timeout when the pairing is revoked mid-wait', async () => {
    vi.useFakeTimers()
    try {
      const { client, set, listenerCount } = fakeClient('reconnecting')
      const pending = waitForRpcClientReconnected(client, 10_000)
      set('auth-failed')
      await expect(pending).resolves.toBe(false)
      expect(listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    // Virtual-time advancement yields real macrotasks; allow loaded runners more wall-clock time.
  }, 30_000)

  it('tears down cleanly when the state change fires synchronously during subscribe', async () => {
    vi.useFakeTimers()
    try {
      const { client, listenerCount } = fakeClient('reconnecting', {
        notifyDuringSubscribe: 'connected'
      })
      await expect(waitForRpcClientReconnected(client, 10_000)).resolves.toBe(true)
      expect(listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    // Virtual-time advancement yields real macrotasks; allow loaded runners more wall-clock time.
  }, 30_000)
})
