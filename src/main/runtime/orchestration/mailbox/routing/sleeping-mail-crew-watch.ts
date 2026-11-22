import {
  sessionCrewChanges,
  type CrewChanges,
  type CrewInvalidation
} from '../../crew/crew-changes'
import { sleepingMailChangeScope } from './sleeping-mail-change-scope'

type SleepingMailScope = { mailboxes: string[]; panes: string[] }

/** Crew changes that name a sleeper's mailboxes, Dispatches or parties re-check those, and only
 *  while some agent sleeps: with none, crew writes keep their "nobody listening" shortcut. A change
 *  that names nothing moves no sleeper's mail; arriving mail requests its own mailbox's wake. */
export class SleepingMailCrewWatch {
  private stop: (() => void) | null = null

  constructor(
    private readonly runtimeChanges: () => CrewChanges,
    private readonly publish: (scope: SleepingMailScope) => void
  ) {}

  sync(wanted: boolean): void {
    if (wanted && !this.stop) {
      const changed = (facets: CrewInvalidation): void => {
        const scope = sleepingMailChangeScope(facets)
        if (scope && (facets.has('traffic') || facets.has('topology') || facets.has('records'))) {
          this.publish(scope)
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
