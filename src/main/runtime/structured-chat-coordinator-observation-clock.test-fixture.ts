import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from './orca-runtime'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'

export function createCoordinatorMailObservationClock(
  getHost: () => StructuredAgentSessionHost,
  sessionId: string
) {
  let active = false
  return {
    start(): void {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      active = true
    },
    async observe(ms: number): Promise<void> {
      if (!active) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return
      }
      await vi.advanceTimersByTimeAsync(ms)
      await waitForStructuredAgentSessionRecovery()
      await getHost().flushStreamedEvents(sessionId)
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    async edgesAnswered(
      runtime: Pick<OrcaRuntimeService, 'onStructuredSessionStatusForMail'>,
      _wait: { timeout: number }
    ): Promise<void> {
      runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
      runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
      await waitForStructuredAgentSessionRecovery()
      await getHost().flushStreamedEvents(sessionId)
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    async drainClosedDatabaseRepair(): Promise<void> {
      if (!active) {
        return
      }
      // The runtime's orphan mailbox repair must still run against the closed database.
      await vi.advanceTimersByTimeAsync(2_000)
      await waitForStructuredAgentSessionRecovery()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(vi.getTimerCount()).toBe(0)
    },
    restore(): void {
      if (active) {
        vi.useRealTimers()
      }
      active = false
    }
  }
}
