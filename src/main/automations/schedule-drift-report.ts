/**
 * Reports saved schedules whose meaning changed in the release that repaired the cron parser.
 *
 * Both repairs were correct, but a persisted cadence can now fire several times more — or
 * several times less — than it did yesterday. The louder direction announces itself through
 * spend; the quieter one does not, because nobody notices a job that stopped running. One
 * line per affected record at startup is the smallest signal that makes either detectable.
 */
import type { Automation } from '../../shared/automations-types'
import { describeAutomationScheduleDrift } from '../../shared/automation-schedule-drift'

export function reportAutomationScheduleDrift(automations: readonly Automation[]): number {
  const drifted = automations.flatMap((automation) => {
    const drift = describeAutomationScheduleDrift(automation.rrule)
    return drift ? [{ automation, drift }] : []
  })
  if (drifted.length === 0) {
    return 0
  }
  console.warn(
    `[automations] ${drifted.length} saved schedule(s) changed meaning when the cron parser was repaired; review them:`
  )
  for (const { automation, drift } of drifted) {
    const direction = drift.currentRunsPerYear > drift.previousRunsPerYear ? 'more' : 'fewer'
    console.warn(
      `[automations]   "${automation.name}" (${automation.id}) "${drift.expression}" now runs ` +
        `${direction}: about ${drift.currentRunsPerYear}/year, was about ${drift.previousRunsPerYear}/year`
    )
  }
  return drifted.length
}
