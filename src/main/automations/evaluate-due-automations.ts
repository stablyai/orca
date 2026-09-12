import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import { isValidAutomationSchedule } from '../../shared/automation-schedule-parsing'
import type { AutomationRunWriter } from './automation-run-writer'

export async function evaluateDueAutomations(
  store: Store,
  runs: AutomationRunWriter,
  evaluate: (automation: Automation, now: number) => Promise<void>,
  publish: PublishAutomationsChanged | null
): Promise<void> {
  const now = Date.now()
  for (const automation of store.listAutomations()) {
    if (!automation.enabled || automation.nextRunAt > now) {
      continue
    }
    // Older clients could persist fields that the scheduler never implemented.
    if (!isValidAutomationSchedule(automation.rrule)) {
      const run = runs.createRun(automation, automation.nextRunAt)
      runs.updateRun({
        runId: run.id,
        status: 'skipped_unavailable',
        error: 'Invalid automation schedule. Update the trigger and re-enable this automation.'
      })
      store.updateAutomation(automation.id, { enabled: false })
      publish?.({ reason: 'definition' })
      continue
    }
    await evaluate(automation, now)
  }
}
