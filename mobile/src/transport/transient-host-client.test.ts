import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import type { RpcClientContextValue } from './rpc-client-context-contract'
import { acquireTransientHostClient } from './transient-host-client'
import type { HostProfile } from './types'

const host: HostProfile = {
  id: 'desktop-4',
  name: 'Desktop 4',
  endpoint: 'wss://desktop-4.example.test',
  deviceToken: 'token',
  publicKeyB64: 'public-key',
  lastConnected: 1
}

describe('acquireTransientHostClient', () => {
  it('does nothing for a pre-aborted acquisition', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      controller.abort()
      const onClientOwned = vi.fn()
      const context = {
        acquire: vi.fn(),
        subscribeAllHosts: vi.fn(),
        subscribeHostState: vi.fn(),
        getAllClients: vi.fn(),
        getKnownState: vi.fn(),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue

      await expect(
        acquireTransientHostClient(context, host, { signal: controller.signal, onClientOwned })
      ).resolves.toBeNull()
      expect(context.acquire).not.toHaveBeenCalled()
      expect(context.subscribeAllHosts).not.toHaveBeenCalled()
      expect(context.subscribeHostState).not.toHaveBeenCalled()
      expect(context.releaseAndCloseIfUnused).not.toHaveBeenCalled()
      expect(onClientOwned).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases an existing client lease exactly once', async () => {
    const client = {} as RpcClient
    const releaseAndCloseIfUnused = vi.fn()
    const context = {
      acquire: vi.fn(() => client),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => [{ hostId: host.id, client }]),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused
    } as unknown as RpcClientContextValue

    const lease = await acquireTransientHostClient(context, host)
    expect(lease?.client).toBe(client)
    lease?.release()
    lease?.release()
    expect(releaseAndCloseIfUnused).toHaveBeenCalledOnce()
  })

  it('releases ownership when opening the paired desktop fails', async () => {
    let notify = () => {}
    const releaseAndCloseIfUnused = vi.fn()
    const context = {
      acquire: vi.fn(() => null),
      subscribeAllHosts: vi.fn((listener: () => void) => {
        notify = listener
        return vi.fn()
      }),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => []),
      getKnownState: vi
        .fn<() => 'connecting' | 'auth-failed'>()
        .mockReturnValueOnce('connecting')
        .mockReturnValue('auth-failed'),
      releaseAndCloseIfUnused
    } as unknown as RpcClientContextValue

    const pending = acquireTransientHostClient(context, host)
    await Promise.resolve()
    notify()
    await expect(pending).resolves.toBeNull()
    expect(releaseAndCloseIfUnused).toHaveBeenCalledOnce()
  })

  it('serializes transient leases across callers', async () => {
    const firstClient = {} as RpcClient
    const secondClient = {} as RpcClient
    const firstContext = {
      acquire: vi.fn(() => firstClient),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => [{ hostId: host.id, client: firstClient }]),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue
    const secondContext = {
      acquire: vi.fn(() => secondClient),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => [{ hostId: 'desktop-5', client: secondClient }]),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue

    const first = await acquireTransientHostClient(firstContext, host)
    const secondPending = acquireTransientHostClient(secondContext, { ...host, id: 'desktop-5' })
    await Promise.resolve()
    expect(secondContext.acquire).not.toHaveBeenCalled()

    first?.release()
    const second = await secondPending
    expect(second?.client).toBe(secondClient)
    second?.release()
  })

  it('cancels a pending acquisition and releases its turn', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const releaseAndCloseIfUnused = vi.fn()
      const context = {
        acquire: vi.fn(() => null),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => []),
        getKnownState: vi.fn(() => 'connecting'),
        releaseAndCloseIfUnused
      } as unknown as RpcClientContextValue

      const pending = acquireTransientHostClient(context, host, { signal: controller.signal })
      await Promise.resolve()
      controller.abort()

      await expect(pending).resolves.toBeNull()
      expect(releaseAndCloseIfUnused).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not acquire after an abort races a granted queue turn', async () => {
    const firstClient = {} as RpcClient
    const first = await acquireTransientHostClient(
      {
        acquire: vi.fn(() => firstClient),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => [{ hostId: host.id, client: firstClient }]),
        getKnownState: vi.fn(() => 'connected'),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue,
      host
    )
    const controller = new AbortController()
    const secondContext = {
      acquire: vi.fn(() => ({}) as RpcClient),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => []),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue
    const thirdClient = {} as RpcClient
    const thirdContext = {
      acquire: vi.fn(() => thirdClient),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => [{ hostId: 'desktop-6', client: thirdClient }]),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue
    const second = acquireTransientHostClient(
      secondContext,
      { ...host, id: 'desktop-5' },
      {
        signal: controller.signal
      }
    )
    const third = acquireTransientHostClient(thirdContext, { ...host, id: 'desktop-6' })

    first?.release()
    controller.abort()

    await expect(second).resolves.toBeNull()
    expect(secondContext.acquire).not.toHaveBeenCalled()
    const thirdLease = await third
    expect(thirdLease?.client).toBe(thirdClient)
    thirdLease?.release()
  })

  it('skips a pre-aborted queued caller and grants the next turn', async () => {
    const firstClient = {} as RpcClient
    const first = await acquireTransientHostClient(
      {
        acquire: vi.fn(() => firstClient),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => [{ hostId: host.id, client: firstClient }]),
        getKnownState: vi.fn(() => 'connected'),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue,
      host
    )
    const controller = new AbortController()
    controller.abort()
    const skippedContext = {
      acquire: vi.fn(),
      subscribeAllHosts: vi.fn(),
      subscribeHostState: vi.fn(),
      getAllClients: vi.fn(),
      getKnownState: vi.fn(),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue
    const skipped = acquireTransientHostClient(
      skippedContext,
      { ...host, id: 'desktop-5' },
      { signal: controller.signal }
    )
    const finalClient = {} as RpcClient
    const finalContext = {
      acquire: vi.fn(() => finalClient),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn(() => vi.fn()),
      getAllClients: vi.fn(() => [{ hostId: 'desktop-6', client: finalClient }]),
      getKnownState: vi.fn(() => 'connected'),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue
    const final = acquireTransientHostClient(finalContext, { ...host, id: 'desktop-6' })

    await expect(skipped).resolves.toBeNull()
    expect(skippedContext.acquire).not.toHaveBeenCalled()
    expect(skippedContext.subscribeAllHosts).not.toHaveBeenCalled()
    expect(skippedContext.subscribeHostState).not.toHaveBeenCalled()

    first?.release()
    const finalLease = await final
    expect(finalLease?.client).toBe(finalClient)
    finalLease?.release()
  })

  it('waits for a published disconnected client to reconnect', async () => {
    const client = {} as RpcClient
    let notifyState = () => {}
    let state: 'disconnected' | 'connected' = 'disconnected'
    const context = {
      acquire: vi.fn(() => client),
      subscribeAllHosts: vi.fn(() => vi.fn()),
      subscribeHostState: vi.fn((_hostId: string, listener: () => void) => {
        notifyState = listener
        return vi.fn()
      }),
      getAllClients: vi.fn(() => [{ hostId: host.id, client }]),
      getKnownState: vi.fn(() => state),
      releaseAndCloseIfUnused: vi.fn()
    } as unknown as RpcClientContextValue

    const pending = acquireTransientHostClient(context, host)
    await Promise.resolve()
    expect(context.acquire).toHaveBeenCalledOnce()

    state = 'connected'
    notifyState()
    const lease = await pending
    expect(lease?.client).toBe(client)
    lease?.release()
  })

  it('times out an unreachable owner and lets the next host acquire', async () => {
    vi.useFakeTimers()
    try {
      const unreachableClient = {} as RpcClient
      const unreachableRelease = vi.fn()
      const unreachable = acquireTransientHostClient(
        {
          acquire: vi.fn(() => unreachableClient),
          subscribeAllHosts: vi.fn(() => vi.fn()),
          subscribeHostState: vi.fn(() => vi.fn()),
          getAllClients: vi.fn(() => [{ hostId: host.id, client: unreachableClient }]),
          getKnownState: vi.fn(() => 'connecting'),
          releaseAndCloseIfUnused: unreachableRelease
        } as unknown as RpcClientContextValue,
        host,
        { timeoutMs: 100 }
      )
      const nextClient = {} as RpcClient
      const nextContext = {
        acquire: vi.fn(() => nextClient),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => [{ hostId: 'desktop-5', client: nextClient }]),
        getKnownState: vi.fn(() => 'connected'),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue
      const next = acquireTransientHostClient(
        nextContext,
        { ...host, id: 'desktop-5' },
        { timeoutMs: 1_000 }
      )

      await vi.advanceTimersByTimeAsync(100)

      await expect(unreachable).resolves.toBeNull()
      expect(unreachableRelease).toHaveBeenCalledOnce()
      const nextLease = await next
      expect(nextLease?.client).toBe(nextClient)
      nextLease?.release()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out while queued without blocking later FIFO callers', async () => {
    vi.useFakeTimers()
    try {
      const firstClient = {} as RpcClient
      const first = await acquireTransientHostClient(
        {
          acquire: vi.fn(() => firstClient),
          subscribeAllHosts: vi.fn(() => vi.fn()),
          subscribeHostState: vi.fn(() => vi.fn()),
          getAllClients: vi.fn(() => [{ hostId: host.id, client: firstClient }]),
          getKnownState: vi.fn(() => 'connected'),
          releaseAndCloseIfUnused: vi.fn()
        } as unknown as RpcClientContextValue,
        host
      )
      const timedOutContext = {
        acquire: vi.fn(),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => []),
        getKnownState: vi.fn(() => 'connecting'),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue
      const timedOut = acquireTransientHostClient(
        timedOutContext,
        { ...host, id: 'desktop-5' },
        { timeoutMs: 50 }
      )
      const finalClient = {} as RpcClient
      const finalContext = {
        acquire: vi.fn(() => finalClient),
        subscribeAllHosts: vi.fn(() => vi.fn()),
        subscribeHostState: vi.fn(() => vi.fn()),
        getAllClients: vi.fn(() => [{ hostId: 'desktop-6', client: finalClient }]),
        getKnownState: vi.fn(() => 'connected'),
        releaseAndCloseIfUnused: vi.fn()
      } as unknown as RpcClientContextValue
      const final = acquireTransientHostClient(
        finalContext,
        { ...host, id: 'desktop-6' },
        { timeoutMs: 1_000 }
      )

      await vi.advanceTimersByTimeAsync(50)
      await expect(timedOut).resolves.toBeNull()
      expect(timedOutContext.acquire).not.toHaveBeenCalled()

      first?.release()
      const finalLease = await final
      expect(finalLease?.client).toBe(finalClient)
      finalLease?.release()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
