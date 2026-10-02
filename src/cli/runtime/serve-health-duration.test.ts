import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForForegroundServeChild } from './serve-child-monitor'

class ServeChild extends EventEmitter {
  kill = vi.fn()
}

const healthy = { healthy: true, runtimeId: 'runtime-one' } as const
const unreachable = { healthy: false, reason: 'runtime_unreachable' } as const
const ready = { type: 'orca:serve-ready', version: '1.0.0', runtimeId: 'runtime-one' }

afterEach(() => vi.useRealTimers())

describe('confirmed serve health duration', () => {
  it('does not add healthy segments across an intervening failed probe', async () => {
    vi.useFakeTimers()
    const child = new ServeChild()
    const probe = vi.fn().mockResolvedValue(healthy)
    const result = waitForForegroundServeChild(child as never, null, {
      healthProbe: probe,
      healthCheckIntervalMs: 100_000,
      healthProbeTimeoutMs: 1_000,
      healthFailureLimit: 3
    })
    child.emit('message', ready)
    await vi.advanceTimersByTimeAsync(100_000)
    probe.mockResolvedValueOnce(unreachable)
    await vi.advanceTimersByTimeAsync(300_000)
    child.emit('exit', 0, null)

    expect((await result).healthyDurationMs).toBe(100_000)
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a fully confirmed healthy interval without counting shutdown time', async () => {
    vi.useFakeTimers()
    const child = new ServeChild()
    const probe = vi.fn().mockResolvedValue(healthy)
    const result = waitForForegroundServeChild(child as never, null, {
      healthProbe: probe,
      healthCheckIntervalMs: 100_000,
      healthProbeTimeoutMs: 1_000,
      healthFailureLimit: 1
    })
    child.emit('message', ready)
    await vi.advanceTimersByTimeAsync(300_000)
    probe.mockResolvedValue(unreachable)
    await vi.advanceTimersByTimeAsync(135_000)
    child.emit('exit', null, 'SIGKILL')

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect((await result).healthyDurationMs).toBe(300_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves elapsed readiness duration for handoffs without periodic probes', async () => {
    vi.useFakeTimers()
    const child = new ServeChild()
    const expected = {
      targetVersion: '1.0.0',
      recordFailure: vi.fn(),
      complete: vi.fn(async () => undefined)
    }
    const result = waitForForegroundServeChild(child as never, expected, {
      healthCheckIntervalMs: 100_000,
      healthProbeTimeoutMs: 1_000,
      healthFailureLimit: 3
    })
    child.emit('message', ready)
    await vi.advanceTimersByTimeAsync(299_000)
    child.emit('exit', 0, null)

    expect((await result).healthyDurationMs).toBe(299_000)
    expect(expected.complete).toHaveBeenCalledWith('runtime-one')
    expect(vi.getTimerCount()).toBe(0)
  })
})
