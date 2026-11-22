import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  sessionCrewChanges,
  type CrewChanges,
  type CrewInvalidation
} from '../../crew/crew-changes'
import { sleepingMailChangeScope } from './sleeping-mail-change-scope'

type SleepingMailScope = { mailboxes: Iterable<string>; panes: Iterable<string> }

/** Crew changes that name mailboxes, Dispatches or parties re-check those; one that names nothing
 *  (an owner rebinding, say) re-checks only the mailboxes already owed to sleepers. Watched only
 *  while some agent sleeps, so with none crew writes keep their "nobody listening" shortcut. */
export class SleepingMailCrewWatch {
  private stop: (() => void) | null = null

  constructor(
    private readonly runtimeChanges: () => CrewChanges,
    private readonly publish: (scope: SleepingMailScope) => void,
    private readonly owedMailboxes: () => Iterable<string>
  ) {}

  sync(wanted: boolean): void {
    if (wanted && !this.stop) {
      const changed = (facets: CrewInvalidation): void => {
        if (facets.has('traffic') || facets.has('topology') || facets.has('records')) {
          this.publish(
            sleepingMailChangeScope(facets) ?? { mailboxes: [...this.owedMailboxes()], panes: [] }
          )
        }
      }
      // Idle: this reader reads no names, so crew writes skip their names comparison for it.
      const fromRuntime = this.runtimeChanges().subscribeWithIdle(changed, () => true)
      const fromSessions = sessionCrewChanges.subscribeWithIdle(changed, () => true)
      this.stop = () => {
        fromRuntime()
        fromSessions()
      }
    } else if (!wanted && this.stop) {
      this.stop()
      this.stop = null
    }
  }
}

/** Retries failed wakes when a host becomes connected; its status is broadcast many times while it
 *  stays up, and those repeats can unblock nothing. */
export function retryOnHostConnect(
  subscribe: (listener: (event: RuntimeClientEvent) => void) => unknown,
  retry: () => void
): void {
  const statuses = new Map<string, string>()
  subscribe((event) => {
    if (event.type !== 'sshStateChanged') {
      return
    }
    const was = statuses.get(event.targetId)
    statuses.set(event.targetId, event.state.status)
    if (event.state.status === 'connected' && was !== 'connected') {
      retry()
    }
  })
}
