import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export function createStructuredSessionObservationClock(
  getHost: () => StructuredAgentSessionHost,
  sessionId: string
) {
  function restore(): void {
    vi.useRealTimers()
  }

  return {
    start(): void {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    },
    async observe(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms)
      const host = getHost()
      await host.flushStreamedEvents(sessionId)
      await host.collaboratorsForTests().serialize(sessionId, async () => {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      await host.collaboratorsForTests().serialize(sessionId, async () => {})
    },
    restore,
    async restoreBeforeCleanup(cleanup: () => Promise<void>): Promise<void> {
      restore()
      await cleanup()
    }
  }
}
