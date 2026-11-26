// A snoozed item's wake time as the phone says it: "6:00 PM", "Thu 9:00 AM" or "Nov 30, 9:00 AM".
import { botItemSnoozeTimeFormat } from '../../../../src/shared/bots/bot-item-snooze'
import { uiDateTimeFormat } from '../../i18n/ui-intl-locale'

export function formatPhoneSnoozeTime(until: number, now: number): string {
  return uiDateTimeFormat(botItemSnoozeTimeFormat(until, now)).format(until)
}
