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

function logical(initial: ConnectionState, initialPath: 'lan' | 'tailscale' = 'lan') {
  let state = initial
  let path: 'lan' | 'tailscale' = initialPath
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
    migrateTo,
    moveOn() {
      generation += 1
    }
  }
}

const GRACE_AND_PROBE_MS = 3_000

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers()
  try {
    await run()
  } finally {
    vi.useRealTimers()
  }
}

describe('mobile authenticated tailnet fallback', () => {
  it('returns from a healthy Tailscale-only pairing to a learned LAN on a foreground network check', () =>
    withFakeTimers(async () => {
      const host = logical('connected', 'tailscale')
      const open = vi.fn(() => physical('connected').client)
      const fallback = new MobileDirectTailnetFallback(host.client, open, true)
      fallback.start()
      await vi.advanceTimersByTimeAsync(4_000)

      expect(open).toHaveBeenCalledWith('lan')
      expect(host.client.getActivePath()).toBe('lan')
      expect(host.migrateTo).toHaveBeenCalledTimes(1)
      fallback.stop()
    }))

  it('opens no backup when the primary recovers within the grace period', () =>
    withFakeTimers(async () => {
      const host = logical('connected')
      const open = vi.fn(() => physical('connecting').client)
      const fallback = new MobileDirectTailnetFallback(host.client, open)
      fallback.start()
      host.setState('reconnecting')
      await vi.advanceTimersByTimeAsync(1_500)
      host.setState('connected')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(open).not.toHaveBeenCalled()
      fallback.stop()
    }))

  it('fails over in both directions, migrating only once the backup has authenticated', () =>
    withFakeTimers(async () => {
      const host = logical('connected')
      const tailnet = physical('connecting')
      const lan = physical('connecting')
      const open = vi.fn((path: 'lan' | 'tailscale') =>
        path === 'tailscale' ? tailnet.client : lan.client
      )
      const fallback = new MobileDirectTailnetFallback(host.client, open)
      fallback.start()

      host.setState('reconnecting')
      await vi.advanceTimersByTimeAsync(GRACE_AND_PROBE_MS)
      expect(open).toHaveBeenCalledWith('tailscale')
      expect(host.client.getActivePath()).toBe('lan')
      tailnet.setState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(host.client.getActivePath()).toBe('tailscale')

      host.setState('reconnecting')
      await vi.advanceTimersByTimeAsync(GRACE_AND_PROBE_MS)
      expect(open).toHaveBeenCalledWith('lan')
      expect(host.client.getActivePath()).toBe('tailscale')
      lan.setState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(host.client.getActivePath()).toBe('lan')
      fallback.stop()
    }))

  it('abandons the backup dial when the primary reconnects first', () =>
    withFakeTimers(async () => {
      const host = logical('reconnecting')
      const backup = physical('connecting')
      const fallback = new MobileDirectTailnetFallback(host.client, () => backup.client)
      fallback.start()
      await vi.advanceTimersByTimeAsync(0)

      host.setState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(backup.close).toHaveBeenCalledTimes(1)
      expect(host.migrateTo).not.toHaveBeenCalled()
      fallback.stop()
    }))

  it('discards a backup that authenticates after the client was moved on by something else', () =>
    withFakeTimers(async () => {
      const host = logical('reconnecting')
      const backup = physical('connecting')
      const fallback = new MobileDirectTailnetFallback(host.client, () => backup.client)
      fallback.start()
      await vi.advanceTimersByTimeAsync(0)

      host.moveOn()
      backup.setState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(backup.close).toHaveBeenCalledTimes(1)
      expect(host.migrateTo).not.toHaveBeenCalled()
      fallback.stop()
    }))

  it('does not redial the backup on later reconnect events until the cooldown ends', () =>
    withFakeTimers(async () => {
      const host = logical('reconnecting')
      const backups = [physical('connecting'), physical('connecting')]
      const open = vi.fn(() => backups[open.mock.calls.length - 1]!.client)
      const fallback = new MobileDirectTailnetFallback(host.client, open)
      fallback.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(open).toHaveBeenCalledTimes(1)

      backups[0]!.setState('disconnected')
      await vi.advanceTimersByTimeAsync(0)
      host.setState('connecting')
      host.setState('reconnecting')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(open).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(open).toHaveBeenCalledTimes(2)
      fallback.stop()
    }))

  it('ignores a burst of nudges right after a probe but honors a later one inside the cooldown', () =>
    withFakeTimers(async () => {
      const host = logical('reconnecting')
      const backups = [physical('connecting'), physical('connecting')]
      const open = vi.fn(() => backups[open.mock.calls.length - 1]!.client)
      const fallback = new MobileDirectTailnetFallback(host.client, open)
      fallback.start()
      await vi.advanceTimersByTimeAsync(0)
      backups[0]!.setState('disconnected')
      await vi.advanceTimersByTimeAsync(0)
      expect(open).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      fallback.nudge()
      fallback.nudge()
      await vi.advanceTimersByTimeAsync(0)
      expect(open).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(3_000)
      fallback.nudge()
      await vi.advanceTimersByTimeAsync(0)
      expect(open).toHaveBeenCalledTimes(2)
      fallback.stop()
    }))
})
