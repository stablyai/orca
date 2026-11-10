import { getSystemAwakeClock, type AwakeClock } from '../power/awake-clock'
import type { Store } from '../persistence/loading-store/store'
import { missedBeyondGrace } from './dispatch-refusal'

/** How long the machine must stay awake after a wake before scheduled runs start. A dark wake
 *  (macOS maintenance or Power Nap) lasts seconds, so a run never starts inside one only to have
 *  its agent frozen mid-start when the machine sleeps again.
 *  Known limits: wakes repeatedly shorter than this defer scheduling until one lasts; a fresh
 *  process has no wake history and starts settled; an App Nap-sized stall counts as a wake. */
export const AUTOMATION_WAKE_SETTLE_MS = 2 * 60_000

/** Whether scheduled automation runs may start now. */
export function automationSystemSettled(clock: AwakeClock = getSystemAwakeClock()): boolean {
  return clock.settled(AUTOMATION_WAKE_SETTLE_MS)
}

/** Holds scheduled runs while the system is not settled. It remembers each due occurrence a held
 *  tick would have launched inside its missed-run grace, so the settled tick that finally
 *  evaluates it does not count the gate's own delay against that grace. */
export class AutomationWakeGate {
  /** False while asleep, in a dark wake, or just woken. */
  settled: () => boolean = () => true
  private readonly held = new Map<string, number>()

  admits(
    store: Pick<Store, 'listAutomations' | 'getLatestAutomationOccurrence'>,
    tickMs: number
  ): boolean {
    if (this.settled()) {
      return true
    }
    const now = Date.now()
    for (const automation of store.listAutomations()) {
      if (!automation.enabled || automation.nextRunAt > now) {
        continue
      }
      try {
        const scheduledFor = store.getLatestAutomationOccurrence(automation, now)
        if (
          scheduledFor !== null &&
          !missedBeyondGrace({ automation, scheduledFor, now, tickMs })
        ) {
          this.held.set(automation.id, scheduledFor)
        }
      } catch {
        // A malformed schedule is recorded by the settled tick's own evaluation.
      }
    }
    return false
  }

  /** `missedBeyondGrace`, except an occurrence this gate held while in grace stays eligible. */
  missedBeyondGrace(input: Parameters<typeof missedBeyondGrace>[0]): boolean {
    return this.held.get(input.automation.id) !== input.scheduledFor && missedBeyondGrace(input)
  }

  clear(): void {
    this.held.clear()
  }
}
