import { describe, expect, it, vi } from 'vitest'
import {
  OrcadIdleExitMonitor,
  resolveOrcadIdlePollMs,
  type OrcadIdleProbe,
  type OrcadIdleVerdict
} from './orcad-idle-exit-monitor'

function harness(options: { timeoutMs?: number; lastClientActivityAt?: number } = {}) {
  let now = 1_000
  let lastActivity = options.lastClientActivityAt ?? 0
  const verdicts: Record<string, OrcadIdleVerdict | Error> = { clients: 'idle', terminals: 'idle' }
  const probes: OrcadIdleProbe[] = Object.keys(verdicts).map((name) => ({
    name,
    read: () => {
      const verdict = verdicts[name]
      if (verdict instanceof Error) {
        throw verdict
      }
      return verdict
    }
  }))
  const onIdle = vi.fn()
  const monitor = new OrcadIdleExitMonitor({
    timeoutMs: options.timeoutMs ?? 100,
    probes,
    lastClientActivityAt: () => lastActivity,
    onIdle,
    now: () => now,
    log: () => {}
  })
  return {
    monitor,
    onIdle,
    verdicts,
    advance: (ms: number) => (now += ms),
    touch: () => (lastActivity = now)
  }
}

describe('OrcadIdleExitMonitor', () => {
  it('fires once every probe has stayed idle for the whole quiet period', async () => {
    const h = harness()
    expect(await h.monitor.check()).toBe(false)
    h.advance(99)
    expect(await h.monitor.check()).toBe(false)
    h.advance(1)
    expect(await h.monitor.check()).toBe(true)
    expect(h.onIdle).toHaveBeenCalledWith({ quietSince: 1_000, stoppedAt: 1_100, timeoutMs: 100 })
    h.advance(1_000)
    expect(await h.monitor.check()).toBe(false)
    expect(h.onIdle).toHaveBeenCalledTimes(1)
  })

  it('restarts the quiet period whenever any probe is busy', async () => {
    const h = harness()
    await h.monitor.check()
    h.advance(90)
    h.verdicts.terminals = 'busy'
    expect(await h.monitor.check()).toBe(false)
    h.verdicts.terminals = 'idle'
    h.advance(10)
    expect(await h.monitor.check()).toBe(false)
    h.advance(99)
    expect(await h.monitor.check()).toBe(false)
    h.advance(1)
    expect(await h.monitor.check()).toBe(true)
  })

  it.each([
    ['unverifiable', 'unverifiable' as const],
    ['throwing', new Error('daemon did not answer')]
  ])('treats a %s probe as busy, never as idle', async (_label, verdict) => {
    const h = harness()
    h.verdicts.terminals = verdict
    for (let i = 0; i < 5; i += 1) {
      expect(await h.monitor.check()).toBe(false)
      h.advance(100)
    }
    expect(h.onIdle).not.toHaveBeenCalled()
  })

  it('counts a request that came and went between checks as activity', async () => {
    const h = harness()
    await h.monitor.check()
    h.advance(80)
    h.touch()
    h.advance(20)
    expect(await h.monitor.check()).toBe(false)
    h.advance(80)
    expect(await h.monitor.check()).toBe(true)
  })

  it('does not fire after it was stopped', async () => {
    const h = harness()
    await h.monitor.check()
    h.monitor.stop()
    h.advance(1_000)
    expect(await h.monitor.check()).toBe(false)
    expect(h.onIdle).not.toHaveBeenCalled()
  })

  it('polls often enough for a short test timeout and at most once a minute', () => {
    expect(resolveOrcadIdlePollMs(15 * 60_000)).toBe(60_000)
    expect(resolveOrcadIdlePollMs(2_000)).toBe(400)
    expect(resolveOrcadIdlePollMs(10)).toBe(250)
  })

  it('stops itself on a timer once idle', async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const monitor = new OrcadIdleExitMonitor({
        timeoutMs: 1_000,
        probes: [{ name: 'clients', read: () => 'idle' }],
        lastClientActivityAt: () => 0,
        onIdle,
        log: () => {}
      })
      monitor.start()
      await vi.advanceTimersByTimeAsync(1_600)
      expect(onIdle).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
