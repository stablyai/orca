import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { describeAutomationSchedule } from '../../../src/shared/automation-schedules'
import { formatAutomationSchedule } from './automation-schedule-label'
import { buildAutomationCronSchedule } from '../../../src/shared/automation-schedule-occurrences'
import { AutomationChoice, AutomationField } from './AutomationControls'
import type { AutomationDraft } from './automation-draft'
import { automationStyles as styles } from './automation-styles'

type Cadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
export function AutomationScheduleFields({
  draft,
  change,
  disabled
}: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  disabled: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const cadences: { value: Cadence; label: string }[] = [
    { value: 'hourly', label: t('automations.mobile.hourly', 'Hourly') },
    { value: 'daily', label: t('automations.mobile.daily', 'Daily') },
    { value: 'weekdays', label: t('automations.mobile.weekdays', 'Weekdays') },
    { value: 'weekly', label: t('automations.mobile.weekly', 'Weekly') },
    { value: 'custom', label: t('automations.mobile.customCronOrRRULE', 'Custom cron or RRULE') }
  ]
  const days = Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(getUiIntlLocale(), { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, 7 + day))
    )
  )
  const descriptor = describeAutomationSchedule(draft.rrule)
  const [cadence, setCadence] = useState<Cadence>(
    descriptor.kind === 'invalid' ? 'custom' : descriptor.kind
  )
  const [time, setTime] = useState(
    `${String('hour' in descriptor ? descriptor.hour : 9).padStart(2, '0')}:${String('minute' in descriptor ? descriptor.minute : 0).padStart(2, '0')}`
  )
  const [day, setDay] = useState(String('dayOfWeek' in descriptor ? descriptor.dayOfWeek : 1))
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  function updateSchedule(nextCadence: Cadence, nextTime: string, nextDay: string) {
    if (nextCadence === 'custom') {
      return
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(nextTime)) {
      change({ rrule: '' })
      return
    }
    const [hour, minute] = nextTime.split(':').map(Number)
    change({
      rrule: buildAutomationCronSchedule({
        preset: nextCadence,
        hour,
        minute,
        dayOfWeek: Number(nextDay)
      })
    })
  }
  return (
    <View style={styles.stack}>
      <AutomationChoice
        label={t('automations.mobile.cadence', 'Cadence')}
        value={cadence}
        options={cadences}
        disabled={disabled}
        onSelect={(next) => {
          setCadence(next)
          updateSchedule(next, time, day)
        }}
      />
      {cadence === 'custom' ? (
        <AutomationField
          label={t('automations.mobile.cronOrRRULE', 'Cron or RRULE')}
          literal
          value={draft.rrule}
          onChange={(rrule) => change({ rrule })}
          disabled={disabled}
        />
      ) : (
        <>
          <AutomationField
            label={
              cadence === 'hourly'
                ? t('automations.mobile.minuteFromHHMM', 'Minute (from HH:MM)')
                : t('automations.mobile.timeHHMM24Hour', 'Time (HH:MM, 24 hour)')
            }
            literal
            value={time}
            onChange={(next) => {
              setTime(next)
              updateSchedule(cadence, next, day)
            }}
            disabled={disabled}
          />
          {!validTime ? (
            <Text style={styles.error}>
              {t('automations.mobile.useATimeSuchAs0900', 'Use a time such as 09:00.')}
            </Text>
          ) : null}
          {cadence === 'weekly' ? (
            <AutomationChoice
              label={t('automations.mobile.day', 'Day')}
              value={day}
              options={days.map((label, index) => ({ value: String(index), label }))}
              onSelect={(next) => {
                setDay(next)
                updateSchedule(cadence, time, next)
              }}
              disabled={disabled}
            />
          ) : null}
        </>
      )}
      <AutomationField
        label={t('automations.mobile.timeZone', 'Time zone')}
        literal
        value={draft.timezone}
        onChange={(timezone) => change({ timezone })}
        disabled={disabled}
      />
      <Text style={styles.meta}>
        {formatAutomationSchedule(draft.rrule)} · {draft.timezone}
      </Text>
      <Text style={styles.meta}>
        {t(
          'automations.mobile.runsOnTheSelectedHostKeepThatHostAvailableAtTheScheduledTime',
          'Runs on the selected host. Keep that host available at the scheduled time.'
        )}
      </Text>
    </View>
  )
}
