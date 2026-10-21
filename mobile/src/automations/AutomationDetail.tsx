import { Switch, Text, View } from 'react-native'
import { formatAutomationSchedule } from '../../../src/shared/automation-schedules'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { MobileAutomationRow } from './automation-reply-schema'
import { AutomationButton, AutomationMetadata } from './AutomationControls'
import { automationDate } from './automation-run-presentation'
import { automationStyles as styles } from './automation-styles'

export function AutomationDetail(props: {
  row: MobileAutomationRow
  disabled: boolean
  onBack: () => void
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onRuns: () => void
}) {
  const { automation, item } = props.row
  const orphan = item.selector.kind === 'orphan'
  return (
    <View style={styles.stack}>
      <AutomationButton label="All automations" onPress={props.onBack} />
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>{automation.name}</Text>
        <Switch
          accessibilityLabel={`Run ${automation.name} on schedule`}
          value={automation.enabled}
          onValueChange={props.onToggle}
          disabled={props.disabled || orphan}
        />
      </View>
      {item.selector.kind === 'orphan' ? (
        <Text style={styles.error}>{item.selector.issue}</Text>
      ) : null}
      <View style={styles.card}>
        <AutomationMetadata
          label="Schedule"
          value={`${formatAutomationSchedule(automation.rrule)} · ${automation.timezone}`}
        />
        <AutomationMetadata
          label="Next run"
          value={
            automation.enabled
              ? automationDate(automation.nextRunAt, automation.timezone)
              : 'No next scheduled run'
          }
        />
        <AutomationMetadata label="Agent" value={MOBILE_TUI_AGENT_LABELS[automation.agentId]} />
        <AutomationMetadata
          label="Project"
          value={automation.runContext?.path ?? automation.projectId}
        />
        <AutomationMetadata
          label="Workspace"
          value={
            automation.workspaceMode === 'existing'
              ? (automation.workspaceId ?? 'Unavailable')
              : 'New workspace per run'
          }
        />
      </View>
      <Text style={styles.heading}>Instructions</Text>
      <Text selectable style={styles.text}>
        {automation.prompt}
      </Text>
      <View style={styles.row}>
        <View style={styles.grow}>
          <AutomationButton
            label="Run now"
            onPress={props.onRun}
            primary
            disabled={props.disabled || orphan}
          />
        </View>
        <AutomationButton label="Edit" onPress={props.onEdit} disabled={props.disabled || orphan} />
      </View>
      <AutomationButton label="View all runs" onPress={props.onRuns} />
      <AutomationButton
        label="Delete automation"
        onPress={props.onDelete}
        destructive
        disabled={props.disabled}
      />
    </View>
  )
}
