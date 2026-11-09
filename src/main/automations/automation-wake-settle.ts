import { getSystemAwakeClock, type AwakeClock } from '../power/awake-clock'

/** How long the machine must stay awake after a wake before scheduled runs start. A dark wake
 *  (macOS maintenance or Power Nap) lasts seconds, so a run never starts inside one only to have
 *  its agent frozen mid-start when the machine sleeps again. */
export const AUTOMATION_WAKE_SETTLE_MS = 2 * 60_000

/** Whether scheduled automation runs may start now. */
export function automationSystemSettled(clock: AwakeClock = getSystemAwakeClock()): boolean {
  return clock.settled(AUTOMATION_WAKE_SETTLE_MS)
}
