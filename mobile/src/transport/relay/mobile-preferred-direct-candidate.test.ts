import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPreferredDirectCandidate } from './mobile-preferred-direct-candidate'
import { FakeSession } from '../connection/mobile-endpoint-supervisor-test-fakes'

describe('preferred authenticated direct candidate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps LAN when it authenticates before the secondary candidate starts', async () => {
    const lan = new FakeSession('connected')
    const tailnet = vi.fn(() => new FakeSession('connected'))
    const chosen = openPreferredDirectCandidate(
      [
        { path: 'lan', open: () => lan, timeoutMs: 4_000 },
        { path: 'tailscale', open: tailnet, timeoutMs: 12_000 }
      ],
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await chosen)?.path).toBe('lan')
    expect(tailnet).not.toHaveBeenCalled()
    expect(lan.close).not.toHaveBeenCalled()
  })

  it('uses Tailscale without waiting for an unreachable LAN timeout', async () => {
    const lan = new FakeSession('connecting')
    const tailnet = new FakeSession('connected')
    const chosen = openPreferredDirectCandidate(
      [
        { path: 'lan', open: () => lan, timeoutMs: 4_000 },
        { path: 'tailscale', open: () => tailnet, timeoutMs: 12_000 }
      ],
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(500)

    const result = await chosen
    expect(result?.path).toBe('tailscale')
    expect(result?.client).toBe(tailnet)
    expect(lan.close).toHaveBeenCalledOnce()
    expect(tailnet.close).not.toHaveBeenCalled()
  })

  it('closes all in-flight candidates on cancellation', async () => {
    const lan = new FakeSession('connecting')
    const tailnet = new FakeSession('connecting')
    const abort = new AbortController()
    const chosen = openPreferredDirectCandidate(
      [
        { path: 'lan', open: () => lan, timeoutMs: 4_000 },
        { path: 'tailscale', open: () => tailnet, timeoutMs: 12_000 }
      ],
      abort.signal
    )
    await vi.advanceTimersByTimeAsync(500)
    abort.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(await chosen).toBeNull()
    expect(lan.close).toHaveBeenCalledOnce()
    expect(tailnet.close).toHaveBeenCalledOnce()
  })
})
