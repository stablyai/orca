import { CalendarClock, ChevronRight } from 'lucide-react-native'
import { Pressable, Switch, Text, View } from 'react-native'
import { formatAutomationSchedule } from '../../../src/shared/automation-schedules'
import { colors } from '../theme/mobile-theme'
import { AutomationButton } from './AutomationControls'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationDate, automationRunStatusLabel } from './automation-run-presentation'
import { automationStyles as styles } from './automation-styles'

export function AutomationList(props: {
  rows: MobileAutomationRow[]
  loaded: boolean
  failed: boolean
  disabled: boolean
  onCreate: () => void
  onOpen: (row: MobileAutomationRow) => void
  onToggle: (row: MobileAutomationRow, enabled: boolean) => void
}) {
  return (
    <View style={styles.stack}>
      <AutomationButton
        label="New automation"
        onPress={props.onCreate}
        primary
        disabled={props.disabled || !props.loaded}
      />
      {!props.loaded && !props.failed ? (
        <Text style={styles.meta}>Loading automations…</Text>
      ) : props.loaded && props.rows.length === 0 ? (
        <View style={styles.empty}>
          <CalendarClock size={28} color={colors.textMuted} />
          <Text style={styles.heading}>Let your agents work on a schedule</Text>
          <Text style={styles.meta}>Create an automation to run a task on this host.</Text>
        </View>
      ) : (
        props.rows.map((row) => {
          const { automation, item } = row
          return (
            <View style={styles.card} key={automation.id}>
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => props.onOpen(row)}
                  style={styles.grow}
                >
                  <View style={styles.row}>
                    <Text style={[styles.heading, styles.grow]}>{automation.name}</Text>
                    <ChevronRight size={16} color={colors.textMuted} />
                  </View>
                </Pressable>
                <Switch
                  accessibilityLabel={`Run ${automation.name} on schedule`}
                  value={automation.enabled}
                  onValueChange={(enabled) => props.onToggle(row, enabled)}
                  disabled={props.disabled || item.selector.kind === 'orphan'}
                />
              </View>
              <Text style={styles.meta}>
                {formatAutomationSchedule(automation.rrule)} · {automation.timezone}
              </Text>
              <Text style={styles.meta}>
                {automation.enabled
                  ? `Next: ${automationDate(automation.nextRunAt, automation.timezone)}`
                  : 'No next scheduled run'}
              </Text>
              <Text style={styles.meta}>
                {item.usageSummary?.lastRunStatus
                  ? `Last: ${automationRunStatusLabel(item.usageSummary.lastRunStatus)} · ${automationDate(item.usageSummary.lastRunAt)}`
                  : 'Latest result not reported'}
              </Text>
              <Text style={styles.meta}>
                {automation.runContext?.path ?? automation.projectId}
                {item.selector.kind === 'ssh' ? ` · SSH ${item.selector.targetId}` : ''}
              </Text>
              {item.selector.kind === 'orphan' ? (
                <Text style={styles.error}>{item.selector.issue}</Text>
              ) : null}
            </View>
          )
        })
      )}
    </View>
  )
}
