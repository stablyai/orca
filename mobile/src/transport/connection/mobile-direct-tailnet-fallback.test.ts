import { describe, expect, it, vi } from 'vitest'
import { MobileDirectTailnetFallback } from './mobile-direct-tailnet-fallback'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState } from './connection-state'

function physical(initial: ConnectionState) {
  let state = initial
  const listeners = new Set<(state: ConnectionState) => void>()
  const close = vi.fn()
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fake implements the RpcClient methods exercised by the fallback.
    client: {
      getState: () => state,
      onStateChange: (listener: (state: ConnectionState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      close
    } as unknown as RpcClient,
    setState(next: ConnectionState) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    close
  }
}

function logical(initial: ConnectionState) {
  let state = initial
  let path: 'lan' | 'tailscale' = 'lan'
  let generation = 1
  const listeners = new Set<(state: ConnectionState) => void>()
  const migrateTo = vi.fn(async (candidate: RpcClient, nextPath: 'lan' | 'tailscale') => {
    expect(candidate.getState()).toBe('connected')
    path = nextPath
    generation += 1
    state = 'connected'
    for (const listener of listeners) {
      listener(state)
    }
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test fake implements the logical client methods exercised by the fallback.
    client: {
      getState: () => state,
      getActivePath: () => path,
      getGeneration: () => generation,
      onStateChange: (listener: (next: ConnectionState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      migrateTo
    } as unknown as StableLogicalRpcClient,
    setState(next: ConnectionState) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    migrateTo
  }
}

describe('mobile authenticated tailnet fallback', () => {
  it('opens no backup when the primary recovers within the grace period', () => {
    vi.useFakeTimers()
    try {
      const host = logical('connected')
      const open = vi.fn(() => physical('connecting').client)
      const fallback = new MobileDirectTailnetFallback(host.client, open)
      fallback.start()
      host.setState('reconnecting')
      vi.advanceTimersByTime(1_500)
      host.setState('connected')
      vi.advanceTimersByTime(10_000)
      expect(open).not.toHaveBeenCalled()
      fallback.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('migrates an unreachable LAN session only after the backup authenticates', async () => {
    const host = logical('connecting')
    const backup = physical('connecting')
    const fallback = new MobileDirectTailnetFallback(host.client, () => backup.client)
    fallback.start()
    host.setState('reconnecting')
    expect(host.migrateTo).not.toHaveBeenCalled()

    backup.setState('connected')
    await vi.waitFor(() => expect(host.migrateTo).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(host.migrateTo).toHaveBeenCalledWith(
      backup.client,
      'tailscale',
      12_000,
      expect.any(Function)
    )
    fallback.stop()
  })

  it('falls back to LAN when an already migrated tailnet path goes offline', async () => {
    const host = logical('reconnecting')
    const tailnet = physical('connecting')
    const lan = physical('connecting')
    const open = vi.fn((path: 'lan' | 'tailscale') =>
      path === 'tailscale' ? tailnet.client : lan.client
    )
    const fallback = new MobileDirectTailnetFallback(host.client, open)
    fallback.start()
    tailnet.setState('connected')
    await vi.waitFor(() => expect(host.migrateTo).toHaveBeenCalledTimes(1))
    expect(host.migrateTo).toHaveBeenNthCalledWith(
      1,
      tailnet.client,
      'tailscale',
      12_000,
      expect.any(Function)
    )

    host.setState('reconnecting')
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('lan'), { timeout: 4000 })
    lan.setState('connected')
    await vi.waitFor(() => expect(host.migrateTo).toHaveBeenCalledTimes(2))
    expect(host.migrateTo).toHaveBeenNthCalledWith(
      2,
      lan.client,
      'lan',
      12_000,
      expect.any(Function)
    )
    fallback.stop()
  })

  it('closes the backup without switching if LAN recovers first', async () => {
    const host = logical('reconnecting')
    const backup = physical('connecting')
    const fallback = new MobileDirectTailnetFallback(host.client, () => backup.client)
    fallback.start()
    host.setState('connected')
    backup.setState('connected')

    await vi.waitFor(() => expect(backup.close).toHaveBeenCalledTimes(1))
    expect(host.migrateTo).not.toHaveBeenCalled()
    fallback.stop()
  })
})
