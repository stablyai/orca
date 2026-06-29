import { describe, expect, it, vi } from 'vitest'
import {
  createRendererRecoveryGuard,
  type RendererRecoveryEventName
} from './renderer-recovery-guard'

describe('renderer recovery guard', () => {
  it('permits the first automatic recoveries and suppresses later events in the TTL', () => {
    let now = 1_000
    const events: RendererRecoveryEventName[] = []
    const guard = createRendererRecoveryGuard({
      now: () => now,
      loopWindowMs: 60_000,
      maxAutomaticRecoveries: 2,
      cooldownMs: 300_000,
      onEvent: (name) => events.push(name)
    })

    guard.recordProcessGone({ reason: 'crashed', exitCode: 5 })
    expect(guard.canScheduleAutomaticRecovery().allowed).toBe(true)
    now += 1_000
    guard.recordProcessGone({ reason: 'oom', exitCode: -1 })
    expect(guard.canScheduleAutomaticRecovery().allowed).toBe(true)
    now += 1_000
    const summary = guard.recordProcessGone({ reason: 'killed', exitCode: 1 })
    const decision = guard.canScheduleAutomaticRecovery()

    expect(summary).toMatchObject({
      totalProcessGoneCount: 3,
      recentProcessGoneCount: 3,
      lastReason: 'killed',
      lastExitCode: 1
    })
    expect(decision.allowed).toBe(false)
    expect(decision.summary).toMatchObject({
      suppressedRecoveryCount: 1,
      degraded: true,
      degradedUntil: now + 300_000
    })
    expect(events).toEqual([
      'renderer_recovery_scheduled',
      'renderer_recovery_scheduled',
      'renderer_recovery_suppressed'
    ])
  })

  it('allows recovery after the cooldown and loop window expire', () => {
    let now = 10_000
    const guard = createRendererRecoveryGuard({
      now: () => now,
      loopWindowMs: 60_000,
      maxAutomaticRecoveries: 2,
      cooldownMs: 300_000
    })

    for (const reason of ['crashed', 'oom', 'killed']) {
      guard.recordProcessGone({ reason, exitCode: 1 })
      guard.canScheduleAutomaticRecovery()
      now += 1_000
    }

    now += 301_000
    guard.recordProcessGone({ reason: 'crashed', exitCode: 2 })
    expect(guard.canScheduleAutomaticRecovery()).toMatchObject({
      allowed: true,
      summary: { recentProcessGoneCount: 1, degraded: false }
    })
  })

  it('resets recent loop state after a stable load period', () => {
    vi.useFakeTimers()
    const events: { name: RendererRecoveryEventName; recent: number; degraded: boolean }[] = []
    const guard = createRendererRecoveryGuard({
      stableLoadMs: 30_000,
      onEvent: (name, summary) =>
        events.push({ name, recent: summary.recentProcessGoneCount, degraded: summary.degraded })
    })

    guard.recordProcessGone({ reason: 'crashed', exitCode: 5 })
    guard.canScheduleAutomaticRecovery()
    guard.onStableLoad()
    vi.advanceTimersByTime(29_999)
    expect(guard.getSummary().recentProcessGoneCount).toBe(1)

    vi.advanceTimersByTime(1)

    expect(guard.getSummary()).toMatchObject({
      totalProcessGoneCount: 1,
      recentProcessGoneCount: 0,
      degraded: false
    })
    expect(events.at(-1)).toEqual({
      name: 'renderer_recovery_stable',
      recent: 0,
      degraded: false
    })
  })

  it('clears the stable load timer on dispose', () => {
    vi.useFakeTimers()
    const onEvent = vi.fn()
    const guard = createRendererRecoveryGuard({
      stableLoadMs: 30_000,
      onEvent
    })

    guard.recordProcessGone({ reason: 'crashed', exitCode: 5 })
    guard.onStableLoad()
    guard.dispose()
    vi.advanceTimersByTime(30_000)

    expect(onEvent).not.toHaveBeenCalledWith('renderer_recovery_stable', expect.anything())
  })
})
