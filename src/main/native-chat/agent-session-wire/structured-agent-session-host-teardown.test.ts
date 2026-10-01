import { describe, expect, it, vi } from 'vitest'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/quit-teardown-deadline'
import {
  GRACEFUL_EXIT_MS as CLAUDE_WINDOWS_GRACEFUL_EXIT_MS,
  SUPERVISED_GRACEFUL_EXIT_MS
} from '../../claude/claude-child-exit-proof-ladder'
import { GRACEFUL_EXIT_MS as CODEX_WINDOWS_GRACEFUL_EXIT_MS } from '../../codex/codex-app-server-connection'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../codex/codex-app-server-posix-supervisor'
import { SNAPSHOT_DRAIN_TIMEOUT_MS } from './structured-agent-session-eviction'
import {
  CHILD_EVICTION_TIMEOUT_MS,
  EVICTION_MARGIN_MS,
  RESUME_MARKER_RECORD_TIMEOUT_MS,
  structuredAgentSessionHostTeardownPhases
} from './structured-agent-session-host-teardown'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const noop = async (): Promise<void> => undefined

describe('structured agent-session host teardown', () => {
  it('names every phase, so the quit-path order is pinned rather than incidental', () => {
    const phases = structuredAgentSessionHostTeardownPhases({
      logger: createStructuredAgentSessionLogger(),
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

  it("derives quit's child-eviction bound from every provider's supervised close", () => {
    // Eviction drains the sink for the resume offer before it stops the child, inside one bound.
    // Each close's tree-kill fallback is deliberately outside it: once main exits the supervisor
    // stops its group itself, and next launch's recovery settles the lease.
    const closes = {
      claude: SUPERVISED_GRACEFUL_EXIT_MS,
      codex: PROVIDER_SUPERVISOR_MAX_STOP_MS,
      // No supervisor on Windows, so its closes wait less than any supervised one.
      claudeWindows: CLAUDE_WINDOWS_GRACEFUL_EXIT_MS,
      codexWindows: CODEX_WINDOWS_GRACEFUL_EXIT_MS
    }
    for (const closeMs of Object.values(closes)) {
      expect(SNAPSHOT_DRAIN_TIMEOUT_MS + closeMs + EVICTION_MARGIN_MS).toBeLessThanOrEqual(
        CHILD_EVICTION_TIMEOUT_MS
      )
    }
    // The resume markers recorded after eviction still fit under quit's global deadline.
    expect(CHILD_EVICTION_TIMEOUT_MS + RESUME_MARKER_RECORD_TIMEOUT_MS).toBeLessThan(
      WILL_QUIT_TEARDOWN_DEADLINE_MS
    )
  })

  it('ends child eviction as soon as every chat has closed, not at its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const evict = structuredAgentSessionHostTeardownPhases({
      logger: createStructuredAgentSessionLogger(),
      idleSweep: { dispose: noop },
      runtimeState: { stopLeaseRenewal: () => undefined, flushAllEventSinks: noop },
      tasks: { drainAttaches: noop },
      evictOwnedSessions: noop,
      beginResumeMarkers: () => {},
      recordResumeMarkers: noop
    }).find((phase) => phase.name === 'evict-owned-sessions')
    try {
      let finished = false
      const run = Promise.resolve(evict?.run()).then(() => {
        finished = true
      })
      // No timer advances: the phase settles with the eviction, not at CHILD_EVICTION_TIMEOUT_MS.
      await vi.advanceTimersByTimeAsync(0)
      expect(finished).toBe(true)
      await run
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds stalled recovery publication without preventing later cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const log = recordingStructuredAgentSessionLogger()
    const pending = Promise.withResolvers<void>()
    const cleaned = vi.fn(async () => {})
    const flush = vi.fn(async () => cleaned())
    const phases = structuredAgentSessionHostTeardownPhases({
      logger: log.logger,
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
      expect(log.scopes()).toEqual(['teardown-recovery-capsule'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.resolve()
      vi.useRealTimers()
    }
  })
})
