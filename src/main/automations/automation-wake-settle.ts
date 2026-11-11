import { getSystemAwakeClock, type AwakeClock } from '../power/awake-clock'
import type { Store } from '../persistence/loading-store/store'
import { missedBeyondGrace } from './dispatch-refusal'
import type { Automation } from '../../shared/automations/automation-definition'

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

type HoldStore = Pick<
  Store,
  'listAutomations' | 'getLatestAutomationOccurrence' | 'automationEnablementRevision'
>

/** The eligibility a hold was granted under: the fields that decide whether and when the
 *  occurrence may run, plus the store's count of enable/disable transitions, so a pause and
 *  re-enable revokes the hold even when it restores every field within one millisecond.
 *  Not `updatedAt`: run completion, usage and retention bookkeeping move it on unchanged
 *  definitions. A rename or other non-eligibility edit keeps the hold. */
function eligibilityRevision(
  store: Pick<HoldStore, 'automationEnablementRevision'>,
  automation: Automation
): string {
  return JSON.stringify([
    store.automationEnablementRevision(automation.id),
    automation.enabled,
    automation.rrule,
    automation.dtstart,
    automation.timezone,
    automation.missedRunPolicy,
    automation.missedRunGraceMinutes
  ])
}

/** Holds scheduled runs while the system is not settled. It remembers each due occurrence a held
 *  tick would have launched inside its missed-run grace, so the settled tick that finally
 *  evaluates it does not count the gate's own delay against that grace. A hold is bound to the
 *  eligibility it was granted under: once the user changes the schedule or grace, or pauses the
 *  automation, the current definition's own grace decides. */
export class AutomationWakeGate {
  /** False while asleep, in a dark wake, or just woken. */
  settled: () => boolean = () => true
  private readonly held = new Map<string, { scheduledFor: number; revision: string }>()

  /** Read lazily: the owning service assigns its store after constructing this gate. */
  constructor(private readonly holdStore: () => Pick<HoldStore, 'automationEnablementRevision'>) {}

  admits(store: HoldStore, tickMs: number): boolean {
    const automations = store.listAutomations()
    // Why: each settled() read keeps the awake clock's heartbeat running. With nothing enabled
    // there is nothing to hold, so the heartbeat can idle out. Limit: the first read after one is
    // enabled has no gap evidence from before it, like a fresh process.
    if (!automations.some((automation) => automation.enabled) || this.settled()) {
      return true
    }
    const now = Date.now()
    for (const automation of automations) {
      if (!automation.enabled || automation.nextRunAt > now) {
        continue
      }
      try {
        const scheduledFor = store.getLatestAutomationOccurrence(automation, now)
        if (
          scheduledFor !== null &&
          !missedBeyondGrace({ automation, scheduledFor, now, tickMs })
        ) {
          this.held.set(automation.id, {
            scheduledFor,
            revision: eligibilityRevision(store, automation)
          })
        }
      } catch {
        // A malformed schedule is recorded by the settled tick's own evaluation.
      }
    }
    return false
  }

  /** `missedBeyondGrace`, except an occurrence this gate held while in grace stays eligible
   *  while its definition is unchanged. */
  missedBeyondGrace(input: Parameters<typeof missedBeyondGrace>[0]): boolean {
    const hold = this.held.get(input.automation.id)
    const held =
      hold !== undefined &&
      hold.scheduledFor === input.scheduledFor &&
      hold.revision === eligibilityRevision(this.holdStore(), input.automation)
    return !held && missedBeyondGrace(input)
  }

  clear(): void {
    this.held.clear()
  }
}
