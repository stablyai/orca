import type { Automation } from '../../../shared/automations/automation-definition'

/** In-memory count of pause and re-enable transitions per automation, for the scheduler's wake
 *  gate: a pause and re-enable can restore every field, even `updatedAt` within one ms, and run
 *  bookkeeping moves `updatedAt` without any user change. Every re-enable goes through
 *  `updateAutomation`; `disableAutomations` need not count, since the gate only holds enabled
 *  rows and coming back needs a re-enable. Not persisted: holds do not survive a restart. */
export class AutomationEnablementTransitions {
  private readonly counts = new Map<string, number>()

  revision(id: string): number {
    return this.counts.get(id) ?? 0
  }

  /** Runs an update of `id`, counting it when it flips the automation's `enabled`. */
  track(stored: readonly Automation[], id: string, update: () => Automation): Automation {
    const wasEnabled = stored.find((entry) => entry.id === id)?.enabled
    const updated = update()
    if (wasEnabled !== undefined && updated.enabled !== wasEnabled) {
      this.counts.set(id, this.revision(id) + 1)
    }
    return updated
  }
}
