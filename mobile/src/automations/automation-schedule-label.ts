import {
  describeAutomationSchedule,
  type AutomationScheduleDescriptor
} from '../../../src/shared/automation-schedules'
import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'

// Translate whole sentences; the shared English formatter also serves the CLI.
function formatAutomationScheduleDescriptor(descriptor: AutomationScheduleDescriptor): string {
  if (descriptor.kind === 'invalid') {
    return translate(
      'auto.components.automations.automation.schedule.label.086a5a9fe2',
      'Invalid schedule'
    )
  }
  if (descriptor.kind === 'custom') {
    if (descriptor.expression) {
      return descriptor.expression
    }
    return translate(
      'auto.components.automations.automation.schedule.label.ba20c92073',
      'Custom schedule'
    )
  }
  if (descriptor.kind === 'hourly') {
    return translate(
      'auto.components.automations.automation.schedule.label.a95afb7483',
      'Hourly at :{{minute}}',
      { minute: String(descriptor.minute).padStart(2, '0') }
    )
  }
  const time = new Intl.DateTimeFormat(getUiIntlLocale(), {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(2024, 0, 1, descriptor.hour, descriptor.minute))
  if (descriptor.kind === 'daily') {
    return translate(
      'auto.components.automations.automation.schedule.label.280ccd2701',
      'Daily at {{time}}',
      { time }
    )
  }
  if (descriptor.kind === 'weekdays') {
    return translate(
      'auto.components.automations.automation.schedule.label.3f1422adc1',
      'Weekdays at {{time}}',
      { time }
    )
  }
  return translate(
    'auto.components.automations.automation.schedule.label.cc71e252ba',
    '{{day}}s at {{time}}',
    {
      day: new Intl.DateTimeFormat(getUiIntlLocale(), { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + descriptor.dayOfWeek))
      ),
      time
    }
  )
}

export function formatAutomationSchedule(scheduleExpression: string): string {
  return formatAutomationScheduleDescriptor(describeAutomationSchedule(scheduleExpression))
}
