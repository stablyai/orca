import { describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionHostTeardownPhases } from './structured-agent-session-host-teardown'

describe('structured agent-session host teardown', () => {
  it('names every phase, so the quit-path order is pinned rather than incidental', () => {
    const noop = async (): Promise<void> => undefined
    const phases = structuredAgentSessionHostTeardownPhases({
      idleSweep: { dispose: noop },
      runtimeState: { stopLeaseRenewal: () => undefined, flushAllEventSinks: noop },
      tasks: { drainAttaches: noop },
      evictOwnedSessions: noop,
      beginResumeMarkers: () => {},
      recordResumeMarkers: noop
    })
    expect(phases.map((phase) => phase.name)).toEqual([
      'dispose-idle-sweep',
      'begin-resume-markers',
      'stop-lease-renewal',
      'drain-attaches',
      'evict-owned-sessions',
      'record-resume-markers',
      'flush-event-sinks'
    ])
  })

  it('bounds stalled recovery publication without preventing later cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = Promise.withResolvers<void>()
    const cleaned = vi.fn(async () => {})
    const flush = vi.fn(async () => cleaned())
    const phases = structuredAgentSessionHostTeardownPhases({
      idleSweep: { dispose: cleaned },
      runtimeState: { stopLeaseRenewal: () => {}, flushAllEventSinks: flush },
      tasks: { drainAttaches: cleaned },
      evictOwnedSessions: cleaned,
      beginResumeMarkers: () => {},
      recordResumeMarkers: () => pending.promise
    })
    try {
      const teardown = (async () => {
        for (const phase of phases) {
          await phase.run()
        }
      })()
      await vi.advanceTimersByTimeAsync(2000)
      await teardown
      expect(cleaned).toHaveBeenCalledTimes(4)
      expect(warning).toHaveBeenCalledWith(
        '[structured-agent-session] recording recovery capsule failed'
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.resolve()
      warning.mockRestore()
      vi.useRealTimers()
    }
  })
})
