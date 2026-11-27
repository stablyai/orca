import { ChevronRight } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type {
  MobileAutomationRow,
  MobileAutomationRun
} from '../../automations/automation-reply-schema'
import {
  automationDate,
  automationRunErrorText,
  automationRunStatusLabel,
  runMatchesOutcome
} from '../../automations/automation-run-presentation'
import { automationRowSubtitle } from '../../automations/AutomationList'
import { AgentSpinner } from '../../agents/presentation/AgentSpinner'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { mobileTuiAgentLabel } from '../../agents/mobile-tui-agents'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { homeListStylesSheet as listSheet } from '../home-list-styles'

/** A scheduled automation, as the Automations page draws it: its name, one line of schedule and
 *  project, and the switch that pauses or resumes it. Tap opens the page. */
export function MobileHomeAutomationRow(props: {
  row: MobileAutomationRow
  project: string | undefined
  enabled: boolean
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onOpen: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const list = useThemedStyles(listSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const [pressed, setPressed] = useState(false)
  const { automation } = props.row
  const { subtitle, orphan } = automationRowSubtitle(props.row, props.project, t, intlLocale)
  return (
    // Siblings, not nested, so screen readers reach the switch apart from the row.
    <View style={[list.row, pressed && list.rowPressed]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${automation.name}, ${mobileTuiAgentLabel(automation.agentId)}, ${subtitle}`}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onPress={props.onOpen}
        style={list.text}
      >
        <Text style={list.title} numberOfLines={1}>
          {automation.name}
        </Text>
        <View style={styles.subtitleLine}>
          {orphan ? null : <MobileAgentIcon agentId={automation.agentId} size={12} />}
          <Text
            style={[list.subtitle, styles.subtitle, orphan && { color: colors.statusRed }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        </View>
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
  const styles = useThemedStyles(stylesSheet)
  const list = useThemedStyles(listSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { run } = props
  const status = automationRunStatusLabel(run.status, t)
  const reason = automationRunErrorText(run, t)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('automations.mobile.runSummary', '{{title}}, {{status}}, {{date}}', {
        title: run.title,
        status,
        date: automationDate(run.scheduledFor, t, intlLocale)
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
          {formatTimeAgo(run.startedAt ?? run.scheduledFor, props.now, t)}
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

const stylesSheet = themedStyleSheet((colors) => ({
  subtitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 1 },
  subtitle: { flexShrink: 1, marginTop: 0 },
  age: { fontSize: 15, color: colors.textMuted }
}))
