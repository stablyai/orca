import { getSystemAwakeClock, WAKE_SETTLE_MS, type AwakeClock } from '../../power/awake-clock'
import type { Store } from '../../persistence/loading-store/store'

/** How long the machine must stay awake after a wake before scheduled runs start. A dark wake
 *  (macOS maintenance or Power Nap) lasts seconds, so a run never starts inside one only to have
 *  its agent frozen mid-start when the machine sleeps again.
 *  Known limits: wakes repeatedly shorter than this defer scheduling until one lasts; a fresh
 *  process has no wake history and starts settled; an App Nap-sized stall counts as a wake. */
export const AUTOMATION_WAKE_SETTLE_MS = WAKE_SETTLE_MS

/** Whether scheduled automation runs may start now. */
export function automationSystemSettled(clock: AwakeClock = getSystemAwakeClock()): boolean {
  return clock.settled(AUTOMATION_WAKE_SETTLE_MS)
}

/** Holds scheduled runs while unsettled; the next admitted pass credits its capped wait against grace. */
export class AutomationWakeGate {
  /** False while asleep, in a dark wake, or just woken. */
  settled: () => boolean = () => true
  private heldSince: number | null = null

  admits(store: Pick<Store, 'listAutomations'>): boolean {
    // Why: each settled() read keeps the awake clock's heartbeat running. With nothing enabled
    // there is nothing to hold, so the heartbeat can idle out. Limit: the first read after one is
    // enabled has no gap evidence from before it, like a fresh process.
    if (!store.listAutomations().some((automation) => automation.enabled) || this.settled()) {
      return true
    }
    this.heldSince ??= Date.now()
    return false
  }

  /** The wait since the first held tick, capped at the settle wait plus one tick; 0 if none held. */
  takeDelayMs(now: number, tickMs: number): number {
    const heldMs = this.heldSince === null ? 0 : now - this.heldSince
    this.heldSince = null
    // Why the extra tick: an overdue tick can beat the resume event. Clamped at 0 for NTP steps back.
    return Math.max(0, Math.min(heldMs, AUTOMATION_WAKE_SETTLE_MS + tickMs))
  }
}
