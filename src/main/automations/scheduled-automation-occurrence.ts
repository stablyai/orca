import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import { isValidAutomationTimezone } from '../../shared/automation-zoned-occurrences'
import type { AutomationRunWriter } from './automation-run-writer'

export function prepareScheduledAutomationOccurrence(
  store: Store,
  runs: AutomationRunWriter,
  automation: Automation,
  now: number,
  publish: PublishAutomationsChanged | null
): number | null {
  if (!isValidAutomationTimezone(automation.timezone)) {
    const run = runs.createRun(automation, automation.nextRunAt)
    runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      error: 'Invalid automation timezone. Update the timezone and re-enable this automation.'
    })
    store.updateAutomation(automation.id, { enabled: false })
    publish?.({ reason: 'definition' })
    return null
  }
  const scheduledFor = store.getLatestAutomationOccurrence(automation, now)
  if (scheduledFor === null) {
    store.advanceAutomationNextRun(automation.id, now)
    return null
  }
  const graceMs = automation.missedRunGraceMinutes * 60 * 1000
  if (now - scheduledFor > graceMs) {
    const missed = runs.createRun(automation, scheduledFor)
    runs.updateRun({
      runId: missed.id,
      status: 'skipped_missed',
      workspaceId: automation.workspaceId,
      error: 'Orca was unavailable during the missed-run grace window.'
    })
    store.advanceAutomationNextRun(automation.id, now)
    return null
  }
  return scheduledFor
}
