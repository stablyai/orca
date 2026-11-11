import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import { StructuredAgentSessionStatusFeed } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { waitForStructuredAgentSessionRecovery } from '../../../agent-session/structured-agent-session-runtime'
import { awakeNow, createAwakeClock, type AwakeClock } from '../../../../power/awake-clock'
import { appendFileSync } from 'node:fs'
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
  const pending = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    )
    return work
  }
  const drain = async () => {
    while (pending.size) {
      await Promise.allSettled(pending)
    }
  }
  const timers = new Map<Parameters<typeof clearTimeout>[0], { delay: number; stack: string }>()
  const trace = (event: string, timer: Parameters<typeof clearTimeout>[0], detail?: object) => {
    const path = process.env.ORCA_MAIL_TIMER_TRACE
    if (path) {
      appendFileSync(path, `${JSON.stringify({ event, timer: Number(timer), ...detail })}\n`)
    }
  }
  return {
    install(): void {
      pending.clear()
      const publish = StructuredAgentSessionStatusFeed.prototype.publish
      vi.spyOn(StructuredAgentSessionStatusFeed.prototype, 'publish').mockImplementation(function (
        this: StructuredAgentSessionStatusFeed,
        ...args
      ) {
        const result = publish.apply(this, args)
        return result instanceof Promise ? track(result) : result
      })
      // The existing private delivery promise spans sends and recursive reruns after settlement.
      const deliveryPrototype =
        OrchestrationStructuredMailboxPointerDelivery.prototype as unknown as {
          deliver(mailbox: string, types?: ReadonlySet<string>): Promise<void>
        }
      const deliver = deliveryPrototype.deliver
      vi.spyOn(deliveryPrototype, 'deliver').mockImplementation(function (
        this: typeof deliveryPrototype,
        ...args
      ) {
        return track(deliver.apply(this, args))
      })
    },
    drain,
    start(): void {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      timers.clear()
      const after = globalThis.setTimeout
      const cancel = globalThis.clearTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        const created = {
          delay: delay ?? 0,
          stack: new Error('coordinator mail timer creation').stack ?? ''
        }
        const timer = after(() => {
          timers.delete(timer)
          trace('fired', timer)
          callback(...args)
        }, delay)
        timers.set(timer, created)
        trace('created', timer, created)
        return timer
      })
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
        if (timer !== undefined) {
          trace('cancelled', timer)
          timers.delete(timer)
        }
        return cancel(timer)
      })
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
      await drain()
    },
    async edgesAnswered(
      runtime: Pick<OrcaRuntimeService, 'onStructuredSessionStatusForMail'>,
      _wait: { timeout: number }
    ): Promise<void> {
      runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
      runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
      await drain()
    },
    async drainClosedDatabaseRepair(): Promise<void> {
      if (!active) {
        return
      }
      // The runtime's orphan mailbox repair must still run against the closed database.
      await vi.advanceTimersByTimeAsync(2_000)
      await waitForStructuredAgentSessionRecovery()
      trace('drain-start', undefined, { pending: pending.size, timers: [...timers.values()] })
      await drain()
      trace('drain-end', undefined, { pending: pending.size, timers: [...timers.values()] })
      expect(vi.getTimerCount(), JSON.stringify([...timers.values()])).toBe(
        fakeTimeAwakeClock.heartbeats
      )
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
