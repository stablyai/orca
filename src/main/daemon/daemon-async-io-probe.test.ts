import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_ASYNC_IO_TIMEOUT_MS, DaemonAsyncIoProbe } from './daemon-async-io-probe'

afterEach(() => vi.useRealTimers())

describe('daemon asynchronous I/O progress', () => {
  it('does not diagnose a synchronous probe failure as a stall', async () => {
    vi.useFakeTimers()
    const probe = new DaemonAsyncIoProbe(() => {
      throw new Error('probe unavailable')
    })
    await expect(probe.check()).rejects.toThrow('probe unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a completed operation as healthy and caches it without more work', async () => {
    let now = 1
    const start = vi.fn((done: () => void) => done())
    const probe = new DaemonAsyncIoProbe(start, () => now)
    expect(await probe.check()).toEqual({ state: 'healthy', pendingMs: 0 })
    now = 20_000
    expect(await probe.check()).toEqual({ state: 'healthy', pendingMs: 0 })
    expect(start).toHaveBeenCalledTimes(1)
    now = 31_000
    await probe.check()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('detects pending work while timers still run, and never adds more blocked operations', async () => {
    vi.useFakeTimers()
    const start = vi.fn<(done: () => void) => void>()
    const probe = new DaemonAsyncIoProbe(start, () => Date.now())
    const first = probe.check()
    expect(probe.check()).toBe(first)
    await vi.advanceTimersByTimeAsync(DAEMON_ASYNC_IO_TIMEOUT_MS)
    expect(await first).toEqual({ state: 'stalled', pendingMs: DAEMON_ASYNC_IO_TIMEOUT_MS })
    for (let i = 0; i < 100; i++) {
      expect(await probe.check()).toEqual(await first)
    }
    expect(start).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a stall when the original operation finally completes', async () => {
    vi.useFakeTimers()
    let complete = (): void => {}
    const start = vi.fn((done: () => void) => {
      complete = done
    })
    const probe = new DaemonAsyncIoProbe(start, () => Date.now())
    const pending = probe.check()
    await vi.advanceTimersByTimeAsync(DAEMON_ASYNC_IO_TIMEOUT_MS)
    expect((await pending).state).toBe('stalled')
    complete()
    expect(await probe.check()).toEqual({ state: 'healthy', pendingMs: 0 })
    expect(start).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not flag normal delayed completion as a stall', async () => {
    vi.useFakeTimers()
    const probe = new DaemonAsyncIoProbe((done) => {
      setTimeout(done, 100)
    })
    const pending = probe.check()
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).state).toBe('healthy')
    expect(vi.getTimerCount()).toBe(0)
  })
})
