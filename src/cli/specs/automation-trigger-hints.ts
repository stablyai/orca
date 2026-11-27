import type { AutomationScheduleRefusalHints } from '../../shared/automations/scheduling/automation-schedule-refusal'

const ONE_TIME_RUN = 'use --once --by <ISO time> (bots only)'

export const TRIGGER_REPEATS_NOTE = `A trigger always repeats; for a single run, ${ONE_TIME_RUN} instead of a schedule.`

export const TRIGGER_REFUSAL_HINTS: AutomationScheduleRefusalHints = {
  extraForms: 'hourly, daily, weekdays, weekly',
  oneTimeRun: `For a single run, ${ONE_TIME_RUN}.`
}
