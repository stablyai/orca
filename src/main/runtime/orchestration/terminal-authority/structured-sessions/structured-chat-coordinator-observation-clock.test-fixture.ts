import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { waitForStructuredAgentSessionRecovery } from '../../../agent-session/structured-agent-session-runtime'
import { awakeNow, createAwakeClock, type AwakeClock } from '../../../../power/awake-clock'
import type * as AwakeClockModule from '../../../../power/awake-clock'

// Agent startups read the process-wide awake clock, whose heartbeat is a timer that outlives the
// runtime by design. Under fake time each observation window gets its own production awake clock
// whose heartbeat it counts, so the closed-database drain can still demand every other timer end.
const fakeTimeAwakeClock = vi.hoisted((): { clock: AwakeClock | null; heartbeats: number } => ({
  clock: null,
  heartbeats: 0
}))

vi.mock('../../../../power/awake-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof AwakeClockModule>()
  return {
    ...actual,
    awakeNow: vi.fn(() => (fakeTimeAwakeClock.clock ?? actual.getSystemAwakeClock()).now())
  }
})

function startFakeTimeAwakeClock(): void {
  // Startups read through this export; an unapplied mock would leave the shared clock in play.
  expect(vi.isMockFunction(awakeNow)).toBe(true)
  fakeTimeAwakeClock.heartbeats = 0
  fakeTimeAwakeClock.clock = createAwakeClock({
    wallNow: () => Date.now(),
    monotonicNow: () => globalThis.performance.now(),
    after: (beat, ms) => {
      fakeTimeAwakeClock.heartbeats += 1
      setTimeout(() => {
        fakeTimeAwakeClock.heartbeats -= 1
        beat()
      }, ms).unref()
    }
  })
}

export function createCoordinatorMailObservationClock(
  getHost: () => StructuredAgentSessionHost,
  sessionId: string
) {
  let active = false
  return {
    start(): void {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      startFakeTimeAwakeClock()
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
      const reads = vi.spyOn(getHost(), 'sendAnswer')
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
      expect(vi.getTimerCount()).toBe(fakeTimeAwakeClock.heartbeats)
    },
    restore(): void {
      if (active) {
        vi.useRealTimers()
      }
      // useRealTimers dropped this clock's pending heartbeat along with the other fake timers.
      fakeTimeAwakeClock.clock = null
      fakeTimeAwakeClock.heartbeats = 0
      active = false
    }
  }
}
