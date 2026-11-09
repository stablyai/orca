import { translate } from '../i18n/mobile-i18n'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationDate } from './automation-run-presentation'

/** "Next: <date>" in the automation's own timezone, or that a paused one has none. */
export function automationNextRunLabel(
  automation: Pick<MobileAutomationRow['automation'], 'enabled' | 'nextRunAt' | 'timezone'>
): string {
  return automation.enabled
    ? translate('automations.mobile.nextDate', 'Next: {{date}}', {
        date: automationDate(automation.nextRunAt, automation.timezone)
      })
    : translate('automations.mobile.noNextScheduledRun', 'No next scheduled run')
}
