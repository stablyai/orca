import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  sessionCrewChanges,
  type CrewChanges,
  type CrewInvalidation
} from '../../crew/crew-changes'
import { sleepingMailChangeScope } from './sleeping-mail-change-scope'
import type { SleptMailboxWake } from './slept-mailbox-wake'

type SleepingMailScope = { mailboxes: Iterable<string>; panes: Iterable<string> }

/** Crew changes that name mailboxes, Dispatches or parties re-check those; ones that name nothing
 *  (an owner rebinding, say) re-check the mailboxes already owed to sleepers, at most once a
 *  second. Watched only while some agent sleeps, so with none crew writes keep their "nobody
 *  listening" shortcut. */
export class SleepingMailCrewWatch {
  private stop: (() => void) | null = null
  private owedRecheck: ReturnType<typeof setTimeout> | null = null
  private lastOwedRecheck = -Infinity

  constructor(
    private readonly runtimeChanges: () => CrewChanges,
    private readonly publish: (scope: SleepingMailScope) => void,
    private readonly owedMailboxes: () => Iterable<string>
  ) {}

  sync(wanted: boolean): void {
    if (wanted && !this.stop) {
      const changed = (facets: CrewInvalidation): void => {
        if (facets.has('traffic') || facets.has('topology') || facets.has('records')) {
          const scope = sleepingMailChangeScope(facets)
          if (scope) {
            this.publish(scope)
          } else {
            this.recheckOwed()
          }
        }
      }
      // Idle: this reader reads no names, so crew writes skip their names comparison for it.
      const fromRuntime = this.runtimeChanges().subscribeWithIdle(changed, () => true)
      const fromSessions = sessionCrewChanges.subscribeWithIdle(changed, () => true)
      this.stop = () => {
        fromRuntime()
        fromSessions()
        if (this.owedRecheck) {
          clearTimeout(this.owedRecheck)
          this.owedRecheck = null
        }
      }
    } else if (!wanted && this.stop) {
      this.stop()
      this.stop = null
    }
  }

  private recheckOwed(): void {
    if (this.owedRecheck) {
      return
    }
    this.owedRecheck = setTimeout(
      () => {
        this.owedRecheck = null
        this.lastOwedRecheck = Date.now()
        this.publish({ mailboxes: [...this.owedMailboxes()], panes: [] })
      },
      Math.max(0, this.lastOwedRecheck + 1_000 - Date.now())
    )
  }
}

/** When a host becomes connected, retries failed wakes and re-checks the mail already owed to
 *  sleepers: its status is broadcast many times while it stays up, and a host edge can unblock
 *  only a wake that failed, never a sleeper with nothing owed. */
export function retryOnHostConnect(
  subscribe: (listener: (event: RuntimeClientEvent) => void) => unknown,
  wake: Pick<SleptMailboxWake, 'retryFailed' | 'trackedMailboxes'>,
  publish: (scope: SleepingMailScope) => void
): ReadonlySet<string> {
  // Only hosts up now: a disconnected or removed target leaves nothing behind.
  const connected = new Set<string>()
  subscribe((event) => {
    if (event.type !== 'sshStateChanged') {
      return
    }
    if (event.state.status !== 'connected') {
      connected.delete(event.targetId)
      return
    }
    if (!connected.has(event.targetId)) {
      connected.add(event.targetId)
      wake.retryFailed()
      publish({ mailboxes: wake.trackedMailboxes(), panes: [] })
    }
  })
  return connected
}
