import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../codex/codex-app-server-posix-supervisor'
import { SNAPSHOT_DRAIN_TIMEOUT_MS } from './structured-agent-session-eviction'
import {
  CHILD_EVICTION_TIMEOUT_MS,
  structuredAgentSessionHostTeardownPhases
} from './structured-agent-session-host-teardown'

// Codex close observes the supervisor's exit after its timers fire, which run late on a loaded host.
const SUPERVISOR_EXIT_OBSERVATION_HEADROOM_MS = 1_000

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
      'begin-resume-markers',
      'dispose-idle-sweep',
      'stop-lease-renewal',
      'drain-attaches',
      'evict-owned-sessions',
      'record-resume-markers',
      'flush-event-sinks'
    ])
  })

  it("fits the Codex supervisor's longest stop inside quit's child-eviction bound", () => {
    // A quit that times out first leaves the provider running and its lease unreleased. Eviction
    // drains the sink for the resume offer before it stops the child, inside the same bound.
    expect(
      SNAPSHOT_DRAIN_TIMEOUT_MS +
        PROVIDER_SUPERVISOR_MAX_STOP_MS +
        SUPERVISOR_EXIT_OBSERVATION_HEADROOM_MS
    ).toBeLessThan(CHILD_EVICTION_TIMEOUT_MS)
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
