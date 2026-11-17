import { ChevronRight } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type {
  MobileAutomationRow,
  MobileAutomationRun
} from '../../automations/automation-reply-schema'
import { automationNextRunLabel } from '../../automations/automation-next-run-label'
import {
  automationDate,
  automationRunErrorText,
  automationRunStatusLabel,
  runMatchesOutcome
} from '../../automations/automation-run-presentation'
import { formatAutomationSchedule } from '../../automations/automation-schedule-label'
import { AgentSpinner } from '../../components/AgentSpinner'
import { MobileSwitch } from '../../components/MobileSwitch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { mobileTuiAgentLabel } from '../../agents/mobile-tui-agents'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../worktree/agent-row-display'
import { homeListStyles as list } from '../home-list-styles'

/** A scheduled automation: tap opens the page, the switch pauses or resumes it. */
export function MobileHomeAutomationRow(props: {
  row: MobileAutomationRow
  enabled: boolean
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  const { automation, item } = props.row
  const subtitle = `${formatAutomationSchedule(automation.rrule)} · ${mobileTuiAgentLabel(automation.agentId)}`
  const next = automationNextRunLabel(automation)
  const lastStatus = item.usageSummary?.lastRunStatus
  const last = lastStatus
    ? t('home.automationsTab.lastStatus', 'Last: {{status}}', {
        status: automationRunStatusLabel(lastStatus)
      })
    : automation.enabled
      ? null
      : t('home.automationsTab.paused', 'Paused')
  const lastDate = lastStatus ? automationDate(item.usageSummary?.lastRunAt) : null
  return (
    // Siblings, not nested, so screen readers reach the switch apart from the row.
    <View style={[list.row, pressed && list.rowPressed]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[automation.name, subtitle, next, last, lastDate]
          .filter(Boolean)
          .join(', ')}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onPress={props.onOpen}
        style={list.text}
      >
        <Text style={list.title} numberOfLines={1}>
          {automation.name}
        </Text>
        <Text style={list.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {next}
        </Text>
        {last ? (
          <Text style={styles.meta} numberOfLines={1}>
            <Text style={lastStatus ? { color: runStatusColor(lastStatus) } : null}>{last}</Text>
            {lastDate ? ` · ${lastDate}` : null}
          </Text>
        ) : null}
      </Pressable>
      <View style={list.trailing}>
        <MobileSwitch
          value={props.enabled}
          onValueChange={props.onToggle}
          disabled={props.disabled}
          accessibilityLabel={t('automations.mobile.runOnSchedule', 'Run {{name}} on schedule', {
            name: automation.name
          })}
        />
      </View>
    </View>
  )
}

/** A recent run with its outcome and age; tap opens the page. */
export function MobileHomeAutomationRunRow(props: {
  run: MobileAutomationRun
  now: number
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { run } = props
  const status = automationRunStatusLabel(run.status)
  const reason = automationRunErrorText(run)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('automations.mobile.runSummary', '{{title}}, {{status}}, {{date}}', {
        title: run.title,
        status,
        date: automationDate(run.scheduledFor)
      })}
      onPress={props.onOpen}
      style={({ pressed }) => [list.row, pressed && list.rowPressed]}
    >
      <View style={list.status}>
        <AgentSpinner status={runSpinnerStatus(run)} />
      </View>
      <View style={list.text}>
        <Text style={list.title} numberOfLines={1}>
          {run.title}
        </Text>
        <Text style={list.subtitle} numberOfLines={2}>
          {reason ? `${status} · ${reason}` : status}
        </Text>
      </View>
      <View style={list.trailing}>
        <Text style={styles.age}>
          {formatTimeAgo(run.startedAt ?? run.scheduledFor, props.now)}
        </Text>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}

function runSpinnerStatus(run: MobileAutomationRun) {
  if (runMatchesOutcome(run, 'active')) {
    return 'working'
  }
  if (run.status === 'completed') {
    return 'done'
  }
  return run.status === 'dispatch_failed' ? 'failed' : 'inactive'
}

function runStatusColor(status: string): string {
  if (status === 'completed') {
    return colors.statusGreen
  }
  return status === 'dispatch_failed' ? colors.statusRed : colors.textMuted
}

const styles = themedStyleSheet(() => ({
  meta: { fontSize: 13, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  age: { fontSize: 15, color: colors.textMuted }
}))
