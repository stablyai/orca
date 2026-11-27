import { describe, expect, it } from 'vitest'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'

function harness() {
  let now = 0
  const events: string[] = []
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: 45_000,
    stallMs: 8_000,
    checkIntervalMs: 5_000,
    now: () => now,
    onStallDetected: (ms) => (events.push(`stall:${ms}`), true),
    onHangDetected: (ms) => events.push(`hang:${ms}`),
    onHangResolved: (ms) => events.push(`resolved:${ms}`),
    onStallMissed: (ms) => events.push(`missed:${ms}`),
    onEpisodeEndedBySleep: () => events.push('slept'),
    onEpisodeRecoveredAfterSleep: (ms) => events.push(`woke-recovered:${ms}`)
  })
  // Main is silent while the worker keeps ticking.
  const silentFor = (ms: number): void => {
    for (let t = 0; t < ms; t += 5_000) {
      now += 5_000
      loop.tick()
    }
  }
  const sleep = (ms: number): void => {
    now += ms
  }
  return { loop, events, silentFor, sleep }
}

describe('hang watchdog detection loop: sleep is never main-thread silence', () => {
  for (const wakeOrder of ['heartbeat-first', 'tick-first'] as const) {
    it(`stops a detected hang's silence at a long sleep and keeps it recovered (${wakeOrder})`, () => {
      const { loop, events, silentFor, sleep } = harness()
      silentFor(50_000)
      sleep(3_600_000)
      if (wakeOrder === 'heartbeat-first') {
        loop.recordHeartbeat()
        loop.tick()
      } else {
        loop.tick()
        loop.recordHeartbeat()
      }
      expect(events).toEqual(['stall:10000', 'hang:50000', 'woke-recovered:50000'])
    })
  }

  it('treats silence that continues after the wake as a new episode', () => {
    const { events, silentFor, sleep } = harness()
    silentFor(50_000)
    sleep(3_600_000)
    silentFor(15_000)
    expect(events).toEqual(['stall:10000', 'hang:50000', 'slept', 'stall:10000'])
  })

  it('resolves a stall when main relays a suspend, so a short sleep cannot promote it to a hang', () => {
    const { loop, events, silentFor, sleep } = harness()
    silentFor(40_000)
    loop.recordPowerEvent('suspend')
    sleep(10_000)
    loop.tick()
    loop.recordHeartbeat()
    expect(events).toEqual(['stall:10000', 'resolved:40000'])
  })

  it('reports a hang that starts right after waking from a long sleep', () => {
    const { loop, events, silentFor, sleep } = harness()
    loop.recordPowerEvent('suspend')
    sleep(3_600_000)
    silentFor(55_000)
    loop.recordHeartbeat()
    expect(events).toEqual(['stall:10000', 'hang:50000', 'resolved:50000'])
  })

  it('still reports a hang when main never answers after a suspend, less the unseen sleep', () => {
    const { loop, events, silentFor } = harness()
    loop.recordPowerEvent('suspend')
    silentFor(65_000)
    expect(events).toEqual(['hang:50000'])
  })
})
