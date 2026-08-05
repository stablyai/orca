import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostForceReconnectCoordinator, type HostReconnectEntry } from './host-force-reconnect'
import type { RpcClient } from './rpc-client'

describe('HostForceReconnectCoordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('bounds a first reconnect when its same-profile open never settles', async () => {
    vi.useFakeTimers()
    const cancelPendingOpen = vi.fn()
    const coordinator = new HostForceReconnectCoordinator()
    const reconnect = coordinator.run({
      hostId: 'host-1',
      profileVersion: 0,
      getEntry: () => undefined,
      getListenerCount: () => 1,
      removeEntry: vi.fn(),
      cancelPendingOpen,
      openReplacement: () => new Promise<never>(() => {})
    })
    const outcome = reconnect.catch((error: Error) => error.message)

    expect(cancelPendingOpen).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(cancelPendingOpen).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBe('Force Reconnect timed out')
    expect(cancelPendingOpen).toHaveBeenCalledTimes(2)
  })

  it('settles a cancelled reconnect without waiting for its host lookup deadline', async () => {
    vi.useFakeTimers()
    const cancelPendingOpen = vi.fn()
    const coordinator = new HostForceReconnectCoordinator()
    const reconnect = coordinator.run({
      hostId: 'host-1',
      profileVersion: 0,
      getEntry: () => undefined,
      getListenerCount: () => 1,
      removeEntry: vi.fn(),
      cancelPendingOpen,
      openReplacement: () => new Promise<never>(() => {})
    })

    coordinator.cancel('host-1')

    await expect(reconnect).resolves.toBeUndefined()
    expect(cancelPendingOpen).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(reconnect).resolves.toBeUndefined()
  })

  it('keeps a replacement that fails RPC health verification', async () => {
    const close = vi.fn()
    const unsubState = vi.fn()
    const client = {
      sendRequest: vi.fn(async () => {
        throw new Error('health failed')
      }),
      getState: () => 'connected',
      close
    } as unknown as RpcClient
    const fresh: HostReconnectEntry = { client, refCount: 0, unsubState }
    let current: HostReconnectEntry | undefined
    const removeEntry = vi.fn((expected: HostReconnectEntry) => {
      if (current === expected) {
        current = undefined
      }
    })
    const coordinator = new HostForceReconnectCoordinator()

    await expect(
      coordinator.run({
        hostId: 'host-1',
        profileVersion: 0,
        getEntry: () => current,
        getListenerCount: () => 1,
        removeEntry,
        cancelPendingOpen: vi.fn(),
        openReplacement: async () => {
          current = fresh
          return fresh
        }
      })
    ).rejects.toThrow('health failed')

    // Regression: retiring the replacement left the host with no client and no
    // retry loop, so a failed Force Reconnect was unrecoverable in-app.
    expect(unsubState).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(removeEntry).not.toHaveBeenCalledWith(fresh)
    expect(current).toBe(fresh)
  })
})
