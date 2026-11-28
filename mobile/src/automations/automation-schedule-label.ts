import {
  describeAutomationSchedule,
  type AutomationScheduleDescriptor
} from '../../../src/shared/automations/scheduling/automation-schedules'
import type { Translate } from '../i18n/mobile-i18n'

// Translate whole sentences; the shared English formatter also serves the CLI.
export function formatAutomationScheduleDescriptor(
  descriptor: AutomationScheduleDescriptor,
  t: Translate,
  locale: string
): string {
  if (descriptor.kind === 'invalid') {
    return t('auto.components.automations.automation.schedule.label.086a5a9fe2', 'Invalid schedule')
  }
  if (descriptor.kind === 'custom') {
    if (descriptor.expression) {
      return descriptor.expression
    }
    return t('auto.components.automations.automation.schedule.label.ba20c92073', 'Custom schedule')
  }
  if (descriptor.kind === 'hourly') {
    return t(
      'auto.components.automations.automation.schedule.label.a95afb7483',
      'Hourly at :{{minute}}',
      { minute: String(descriptor.minute).padStart(2, '0') }
    )
  }
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(2024, 0, 1, descriptor.hour, descriptor.minute))
  if (descriptor.kind === 'daily') {
    return t(
      'auto.components.automations.automation.schedule.label.280ccd2701',
      'Daily at {{time}}',
      { time }
    )
  }
  if (descriptor.kind === 'weekdays') {
    return t(
      'auto.components.automations.automation.schedule.label.3f1422adc1',
      'Weekdays at {{time}}',
      { time }
    )
  }
  return t(
    'auto.components.automations.automation.schedule.label.cc71e252ba',
    '{{day}}s at {{time}}',
    {
      day: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + descriptor.dayOfWeek))
      ),
      time
    }
  )
}

export function formatAutomationSchedule(
  scheduleExpression: string,
  t: Translate,
  locale: string
): string {
  return formatAutomationScheduleDescriptor(
    describeAutomationSchedule(scheduleExpression),
    t,
    locale
  )
}

/** The schedule, with its time zone only when it isn't the phone's. */
export function automationScheduleText(
  automation: { rrule: string; timezone: string },
  t: Translate,
  locale: string
): string {
  const schedule = formatAutomationSchedule(automation.rrule, t, locale)
  return automation.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone
    ? schedule
    : `${schedule} · ${automation.timezone}`
}
