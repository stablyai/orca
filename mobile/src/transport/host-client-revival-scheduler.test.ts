import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { HostClientRevivalScheduler } from './host-client-revival-scheduler'

vi.mock('./connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: vi.fn(() => () => {})
}))

describe('host client revival scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('paces a large foreground recovery wave without dropping clients', async () => {
    vi.useFakeTimers()
    const notifyForeground = Array.from({ length: 1_000 }, () => vi.fn())
    const clients = notifyForeground.map(
      (notify) => ({ notifyForeground: notify }) as unknown as RpcClient
    )

    const scheduler = new HostClientRevivalScheduler()
    scheduler.schedule(clients, 'app-resume')
    expect(notifyForeground.filter((notify) => notify.mock.calls.length > 0)).toHaveLength(32)

    await vi.runAllTimersAsync()
    expect(notifyForeground.every((notify) => notify.mock.calls[0]?.[0] === 'app-resume')).toBe(
      true
    )
  })

  it('cancels batches that have not started', async () => {
    vi.useFakeTimers()
    const notifyForeground = Array.from({ length: 64 }, () => vi.fn())
    const clients = notifyForeground.map(
      (notify) => ({ notifyForeground: notify }) as unknown as RpcClient
    )

    const scheduler = new HostClientRevivalScheduler()
    scheduler.schedule(clients, 'network-change')
    scheduler.stop()
    await vi.runAllTimersAsync()

    expect(notifyForeground.filter((notify) => notify.mock.calls.length > 0)).toHaveLength(32)
  })
})
