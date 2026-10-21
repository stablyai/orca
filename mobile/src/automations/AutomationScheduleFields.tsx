import { useState } from 'react'
import { Text, View } from 'react-native'
import {
  describeAutomationSchedule,
  formatAutomationSchedule
} from '../../../src/shared/automation-schedules'
import { buildAutomationCronSchedule } from '../../../src/shared/automation-schedule-occurrences'
import { AutomationChoice, AutomationField } from './AutomationControls'
import type { AutomationDraft } from './automation-draft'
import { automationStyles as styles } from './automation-styles'

type Cadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom cron or RRULE' }
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export function AutomationScheduleFields({
  draft,
  change,
  disabled
}: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  disabled: boolean
}) {
  const descriptor = describeAutomationSchedule(draft.rrule)
  const [cadence, setCadence] = useState<Cadence>(
    descriptor.kind === 'invalid' ? 'custom' : descriptor.kind
  )
  const [time, setTime] = useState(
    'hour' in descriptor
      ? `${String(descriptor.hour).padStart(2, '0')}:${String(descriptor.minute).padStart(2, '0')}`
      : '09:00'
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
        label="Cadence"
        value={cadence}
        options={CADENCES}
        disabled={disabled}
        onSelect={(next) => {
          setCadence(next)
          updateSchedule(next, time, day)
        }}
      />
      {cadence === 'custom' ? (
        <AutomationField
          label="Cron or RRULE"
          value={draft.rrule}
          onChange={(rrule) => change({ rrule })}
          disabled={disabled}
        />
      ) : (
        <>
          <AutomationField
            label={cadence === 'hourly' ? 'Minute (from HH:MM)' : 'Time (HH:MM, 24 hour)'}
            value={time}
            onChange={(next) => {
              setTime(next)
              updateSchedule(cadence, next, day)
            }}
            disabled={disabled}
          />
          {!validTime ? <Text style={styles.error}>Use a time such as 09:00.</Text> : null}
          {cadence === 'weekly' ? (
            <AutomationChoice
              label="Day"
              value={day}
              options={DAYS.map((label, index) => ({ value: String(index), label }))}
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
        label="Time zone"
        value={draft.timezone}
        onChange={(timezone) => change({ timezone })}
        disabled={disabled}
      />
      <Text style={styles.meta}>
        {formatAutomationSchedule(draft.rrule)} · {draft.timezone}
      </Text>
      <Text style={styles.meta}>
        Runs on the selected host. Keep that host available at the scheduled time.
      </Text>
    </View>
  )
}
