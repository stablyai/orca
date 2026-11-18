import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import { StructuredAgentSessionStatusFeed } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { waitForStructuredAgentSessionRecovery } from '../../../agent-session/installation/structured-agent-session-runtime'
import { createAwakeClock, type AwakeClock } from '../../../../power/awake-clock'
import type * as AwakeClockModule from '../../../../power/awake-clock'

type MailDeliveryOwner = Pick<
  typeof OrchestrationStructuredMailboxPointerDelivery.prototype,
  'deliverForHandle'
>

function hasDeliveryCompletion(value: MailDeliveryOwner): value is MailDeliveryOwner & {
  deliver(mailbox: string, types?: ReadonlySet<string>): Promise<void>
} {
  return 'deliver' in value && typeof value.deliver === 'function'
}

// Isolate startup clock reads from the process-wide clock during fake observation windows.
const fakeTimeAwakeClock = vi.hoisted((): { clock: AwakeClock | null } => ({
  clock: null
}))

vi.mock('../../../../power/awake-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof AwakeClockModule>()
  return {
    ...actual,
    awakeNow: vi.fn(() => fakeTimeAwakeClock.clock?.now() ?? Date.now())
  }
})

function startFakeTimeAwakeClock(): void {
  fakeTimeAwakeClock.clock = createAwakeClock({
    wallNow: () => Date.now(),
    monotonicNow: () => globalThis.performance.now(),
    after: (beat, ms) => {
      setTimeout(beat, ms).unref()
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
      const deliveryPrototype: MailDeliveryOwner =
        OrchestrationStructuredMailboxPointerDelivery.prototype
      if (!hasDeliveryCompletion(deliveryPrototype)) {
        throw new Error('structured mailbox delivery has no completion method')
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
      await drain()
    },
    restore(): void {
      if (active) {
        vi.useRealTimers()
      }
      // useRealTimers dropped this clock's pending heartbeat along with the other fake timers.
      fakeTimeAwakeClock.clock = null
      active = false
    }
  }
}
