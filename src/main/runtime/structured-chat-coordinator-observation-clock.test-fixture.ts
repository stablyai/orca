import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from './orca-runtime'
import { waitForStructuredAgentSessionRecovery } from './agent-session/structured-agent-session-runtime'

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
      wait: { timeout: number }
    ): Promise<void> {
      // The lane reads each outstanding send by key; a session with none outstanding reads nothing.
      const reads = vi.spyOn(getHost(), 'sendFacts')
      runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
      runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
      await vi.waitFor(async () => {
        await Promise.allSettled(reads.mock.results.map((read) => read.value))
        await new Promise((resolve) => setImmediate(resolve))
        const settled = reads.mock.calls.length
        await new Promise((resolve) => setImmediate(resolve))
        expect(reads.mock.calls.length).toBe(settled)
      }, wait)
      reads.mockRestore()
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
