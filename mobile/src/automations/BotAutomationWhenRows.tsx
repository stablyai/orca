// An agent's automation's When: the desktop's cadence menu as rows, with "Only on events" and
// "When something happens…", which drafts the change in the agent's chat.
import { describeAutomationSchedule } from '../../../src/shared/automations/scheduling/automation-schedules'
import { buildAutomationCronSchedule } from '../../../src/shared/automations/scheduling/automation-schedule-occurrences'
import { ListGroup } from '../components/list/ListGroup'
import type { PickerOption } from '../components/sheets/PickerModal'
import { DrillRow } from '../host-screen/workspace-options/workspace-option-rows'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { BotAutomationDraft } from './bot-automation-edit-draft'
import type { PresentAutomationSheet } from './AutomationSheets'

/** A row naming its choice; tapping it opens the choices in a sheet. */
export function PickerRow<Value extends string>(props: {
  label: string
  value: Value
  options: PickerOption<Value>[]
  onSelect: (value: Value) => void
  present: PresentAutomationSheet
  disabled?: boolean
  searchable?: boolean
}) {
  return (
    <DrillRow
      label={props.label}
      value={props.options.find((option) => option.value === props.value)?.label ?? ''}
      onPress={() =>
        props.present({
          kind: 'picker',
          title: props.label,
          options: props.options,
          selected: props.value,
          searchable: props.searchable,
          onSelect: (value) => {
            const option = props.options.find((entry) => entry.value === value)
            if (option) {
              props.onSelect(option.value)
            }
          }
        })
      }
      disabled={props.disabled}
    />
  )
}

type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly'
type Cadence = Preset | 'custom' | 'none' | 'events'

const HALF_HOURS = Array.from({ length: 48 }, (_, slot) => slot * 30)
const QUARTERS = [0, 15, 30, 45]

export function BotAutomationWhenRows(props: {
  draft: Pick<BotAutomationDraft, 'eventsOnly' | 'rrule'>
  /** Its saved events; without them "Only on events" reads "Never". */
  hasEvents: boolean
  change: (patch: Partial<Pick<BotAutomationDraft, 'eventsOnly' | 'rrule'>>) => void
  /** Null where the agent's chat can't take the draft. */
  onSetUpEvents: (() => void) | null
  present: PresentAutomationSheet
  disabled: boolean
}) {
  const t = useMobileTranslation()
  const { draft } = props
  const descriptor = describeAutomationSchedule(draft.rrule)
  const preset: Preset | null =
    descriptor.kind === 'hourly' ||
    descriptor.kind === 'daily' ||
    descriptor.kind === 'weekdays' ||
    descriptor.kind === 'weekly'
      ? descriptor.kind
      : null
  const hour = 'hour' in descriptor ? descriptor.hour : 9
  const minute = 'minute' in descriptor ? descriptor.minute : 0
  const day = 'dayOfWeek' in descriptor ? descriptor.dayOfWeek : 1
  const build = (next: Preset, at: { hour?: number; minute?: number; day?: number }) =>
    props.change({
      eventsOnly: false,
      rrule: buildAutomationCronSchedule({
        preset: next,
        hour: at.hour ?? hour,
        minute: at.minute ?? minute,
        dayOfWeek: at.day ?? day
      })
    })

  const cadences: PickerOption<Cadence>[] = [
    { value: 'hourly', label: t('automations.mobile.hourly', 'Hourly') },
    { value: 'daily', label: t('automations.mobile.daily', 'Daily') },
    { value: 'weekdays', label: t('automations.mobile.weekdays', 'Weekdays') },
    { value: 'weekly', label: t('automations.mobile.weekly', 'Weekly') },
    // A saved rule the presets can't draw is kept as it is; the phone has no rule editor.
    ...(preset === null
      ? [
          {
            value: 'custom' as const,
            label: t('automations.mobile.customCronOrRRULE', 'Custom cron or RRULE'),
            subtitle: draft.rrule
          }
        ]
      : []),
    ...(props.hasEvents || draft.eventsOnly
      ? [
          {
            value: 'none' as const,
            label: props.hasEvents
              ? t('automations.botTarget.noSchedule', 'Only on events')
              : t('automations.botTarget.never', 'Never')
          }
        ]
      : []),
    ...(props.onSetUpEvents
      ? [
          {
            value: 'events' as const,
            label: t('automations.botTarget.onEvents', 'When something happens…')
          }
        ]
      : [])
  ]
  const cadence: Cadence = draft.eventsOnly ? 'none' : (preset ?? 'custom')
  const clock = new Intl.DateTimeFormat(getUiIntlLocale(), { hour: 'numeric', minute: '2-digit' })
  const timeLabel = (minutes: number) =>
    clock.format(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60))
  const weekday = new Intl.DateTimeFormat(getUiIntlLocale(), { weekday: 'long', timeZone: 'UTC' })
  const at = hour * 60 + minute
  const times = HALF_HOURS.includes(at) ? HALF_HOURS : [...HALF_HOURS, at].sort((a, b) => a - b)
  const minutes = QUARTERS.includes(minute) ? QUARTERS : [...QUARTERS, minute].sort((a, b) => a - b)

  return (
    <ListGroup>
      <PickerRow
        label={t('automations.mobile.cadence', 'Cadence')}
        value={cadence}
        options={cadences}
        present={props.present}
        disabled={props.disabled}
        onSelect={(next) => {
          if (next === 'events') {
            props.onSetUpEvents?.()
          } else if (next === 'none') {
            props.change({ eventsOnly: true })
          } else if (next === 'custom') {
            props.change({ eventsOnly: false })
          } else {
            build(next, {})
          }
        }}
      />
      {cadence === 'weekly' ? (
        <PickerRow
          label={t('automations.mobile.day', 'Day')}
          value={String(day)}
          options={Array.from({ length: 7 }, (_, index) => ({
            value: String(index),
            // 7 January 2024 was a Sunday, the cron week's day 0.
            label: weekday.format(new Date(Date.UTC(2024, 0, 7 + index)))
          }))}
          present={props.present}
          disabled={props.disabled}
          onSelect={(next) => build('weekly', { day: Number(next) })}
        />
      ) : null}
      {cadence === 'hourly' ? (
        <PickerRow
          label={t('automations.botTarget.minute', 'Minute')}
          value={String(minute)}
          options={minutes.map((value) => ({
            value: String(value),
            label: `:${String(value).padStart(2, '0')}`
          }))}
          present={props.present}
          disabled={props.disabled}
          onSelect={(next) => build('hourly', { minute: Number(next) })}
        />
      ) : preset !== null && !draft.eventsOnly ? (
        <PickerRow
          label={t('automations.botTarget.time', 'Time')}
          value={String(at)}
          options={times.map((value) => ({ value: String(value), label: timeLabel(value) }))}
          present={props.present}
          disabled={props.disabled}
          onSelect={(next) =>
            build(preset, { hour: Math.floor(Number(next) / 60), minute: Number(next) % 60 })
          }
        />
      ) : null}
    </ListGroup>
  )
}
