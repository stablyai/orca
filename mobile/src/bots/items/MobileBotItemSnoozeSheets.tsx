// Snoozing from the phone: Snooze… in a row's, the status and the Move to sheets opens the presets
// (Later today, Tomorrow, Monday) with Pick a time… (a day, then an hour) and Unsnooze while snoozed.
import { AlarmClock, AlarmClockOff, CalendarDays } from 'lucide-react-native'
import {
  isBotItemSnoozed,
  isOpenBotItemStatus,
  type BotItem
} from '../../../../src/shared/bots/bot-items'
import {
  botItemSnoozePresetName,
  botItemSnoozePresets
} from '../../../../src/shared/bots/bot-item-snooze'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { PickerListDrawer } from '../../components/sheets/PickerListDrawer'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { useNow } from '../../hooks/use-now'

export type BotItemSnoozeSheet =
  | { kind: 'snooze'; items: readonly BotItem[] }
  | { kind: 'snooze-day'; items: readonly BotItem[] }
  | { kind: 'snooze-hour'; items: readonly BotItem[]; day: number }

const PICK_DAYS = 14
const FIRST_HOUR = 6
const LAST_HOUR = 23

/** Snooze… for the open items among `items`; none when all are closed. */
export function snoozeAction(
  items: readonly BotItem[],
  t: Translate,
  open: (sheet: BotItemSnoozeSheet) => void
): ActionSheetAction[] {
  const snoozable = items.filter((item) => isOpenBotItemStatus(item.status))
  return snoozable.length > 0
    ? [
        {
          id: 'snooze',
          label: t('bots.items.snooze.sheet', 'Snooze…'),
          icon: AlarmClock,
          closeBeforePress: true,
          onPress: () => open({ kind: 'snooze', items: snoozable })
        }
      ]
    : []
}

function startOfDay(at: number, plusDays = 0): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() + plusDays)
  return day.getTime()
}

export function MobileBotItemSnoozeSheets({
  sheet,
  setSheet,
  snooze
}: {
  sheet: BotItemSnoozeSheet | null
  setSheet: (sheet: BotItemSnoozeSheet | null) => void
  snooze: (items: readonly BotItem[], until: number | null) => Promise<boolean>
}) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  // The presets and the hours left today resolve against it while a sheet is up.
  const now = useNow(30_000, sheet !== null)
  const items = sheet?.items ?? []
  const [only] = items
  const snoozedUntil =
    items.length === 1 && only && isBotItemSnoozed(only, now) ? only.snoozedUntil : null
  const presets: ActionSheetAction[] = [
    ...botItemSnoozePresets(now).map((preset): ActionSheetAction => ({
      id: preset.id,
      label: botItemSnoozePresetName(preset, t),
      icon: AlarmClock,
      status: formatPhoneSnoozeTime(preset.at, now, intlLocale),
      onPress: () => void snooze(items, preset.at)
    })),
    {
      id: 'pick',
      label: t('bots.items.snooze.pick', 'Pick a time…'),
      icon: CalendarDays,
      closeBeforePress: true,
      onPress: () => setSheet({ kind: 'snooze-day', items })
    },
    ...(items.some((item) => isBotItemSnoozed(item, now))
      ? [
          {
            id: 'unsnooze',
            label: t('bots.items.snooze.unsnooze', 'Unsnooze'),
            icon: AlarmClockOff,
            onPress: () => void snooze(items, null)
          }
        ]
      : [])
  ]
  const dayName = new Intl.DateTimeFormat(intlLocale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  const days = Array.from({ length: PICK_DAYS }, (_, index) => {
    const day = startOfDay(now, index)
    return {
      id: String(day),
      label:
        index === 0
          ? t('bots.items.snooze.today', 'Today')
          : index === 1
            ? t('bots.items.snooze.tomorrow', 'Tomorrow')
            : dayName.format(day),
      day
    }
  }).filter(({ day }) => day + LAST_HOUR * 60 * 60_000 > now)
  const hourName = new Intl.DateTimeFormat(intlLocale, {
    hour: 'numeric',
    minute: '2-digit'
  })
  const pickedDay = sheet?.kind === 'snooze-hour' ? sheet.day : startOfDay(now)
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, index) => {
    const at = new Date(pickedDay)
    at.setHours(FIRST_HOUR + index)
    return { id: String(at.getTime()), label: hourName.format(at), at: at.getTime() }
  }).filter(({ at }) => at > now)
  return (
    <>
      <ActionSheetModal
        visible={sheet?.kind === 'snooze'}
        title={
          snoozedUntil !== null
            ? t('bots.items.snooze.until', 'Snoozed until {{when}}', {
                when: formatPhoneSnoozeTime(snoozedUntil, now, intlLocale)
              })
            : t('bots.items.snooze.pickTitle', 'Snooze until')
        }
        actions={presets}
        onClose={() => setSheet(sheet?.kind === 'snooze' ? null : sheet)}
      />
      <PickerListDrawer
        visible={sheet?.kind === 'snooze-day'}
        title={t('bots.items.snooze.pickDay', 'Snooze until which day?')}
        items={days}
        selectedId=""
        onSelect={(day) => setSheet({ kind: 'snooze-hour', items, day: day.day })}
        onClose={() => setSheet(sheet?.kind === 'snooze-day' ? null : sheet)}
      />
      <PickerListDrawer
        visible={sheet?.kind === 'snooze-hour'}
        title={t('bots.items.snooze.pickHour', 'At what time?')}
        items={hours}
        selectedId=""
        onSelect={(hour) => void snooze(items, hour.at)}
        onClose={() => setSheet(sheet?.kind === 'snooze-hour' ? null : sheet)}
      />
    </>
  )
}
