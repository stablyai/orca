import type { Automation, AutomationRun } from '../../shared/automations-types'

export function automationPromptForRun(automation: Automation, run: AutomationRun): string {
  if (!run.rerun) {
    return automation.prompt
  }
  return [
    '<orca_rerun_context>',
    'This is a retry of the exact historical run selected by the user.',
    `Automation ID: ${automation.id}`,
    `Attempt ID: ${run.id}`,
    `Selected run ID: ${run.rerun.sourceRunId}`,
    `Original run ID: ${run.rerun.originalRunId}`,
    `Original scheduledFor: ${run.scheduledFor} (${new Date(run.scheduledFor).toISOString()})`,
    run.scheduledTimezone
      ? `Original schedule timezone: ${run.scheduledTimezone}`
      : 'The original schedule timezone was not recorded. Use an existing saved period or task binding. If a local date is required and no binding exists, request that period instead of guessing from the current timezone.',
    'Use the original saved task inputs and time window. If a binding is missing and the original timezone is known, resolve time-relative instructions using the original scheduledFor above.',
    'This explicit historical selection takes precedence over defaults for a new manual run, the current date, or a pending-work queue.',
    'Resume existing work and reuse completed outputs for that occurrence; avoid duplicate external actions.',
    '</orca_rerun_context>',
    '',
    automation.prompt
  ].join('\n')
}
