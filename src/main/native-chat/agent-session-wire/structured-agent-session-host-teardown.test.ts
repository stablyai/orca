import { describe, expect, it, vi } from 'vitest'

import { structuredAgentSessionHostTeardownPhases } from './structured-agent-session-host-teardown'

import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

describe('structured agent-session host teardown', () => {
  it('bounds stalled recovery publication without preventing later cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const log = recordingStructuredAgentSessionLogger()
    const pending = Promise.withResolvers<void>()
    const cleaned = vi.fn(async () => {})
    const flush = vi.fn(async () => cleaned())
    const phases = structuredAgentSessionHostTeardownPhases({
      logger: log.logger,
      idleSweep: { dispose: cleaned },
      runtimeState: {
        stopLeaseRenewal: () => {},
        flushAllEventSinks: flush,
        acquireAborts: { abortAll: () => {} }
      },
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
