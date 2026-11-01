import { automationOrphanIssueText } from './automation-orphan-issue-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CalendarClock, ChevronRight } from 'lucide-react-native'
import { Pressable, Switch, Text, View } from 'react-native'
import { formatAutomationSchedule } from './automation-schedule-label'
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
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.stack}>
      <AutomationButton
        label={t('automations.mobile.newAutomation', 'New automation')}
        onPress={props.onCreate}
        primary
        disabled={props.disabled || !props.loaded}
      />
      {!props.loaded && !props.failed ? (
        <Text style={styles.meta}>
          {t('automations.mobile.loadingAutomations', 'Loading automations…')}
        </Text>
      ) : props.loaded && props.rows.length === 0 ? (
        <View style={styles.empty}>
          <CalendarClock size={28} color={colors.textMuted} />
          <Text style={styles.heading}>
            {t(
              'automations.mobile.letYourAgentsWorkOnASchedule',
              'Let your agents work on a schedule'
            )}
          </Text>
          <Text style={styles.meta}>
            {t(
              'automations.mobile.createAnAutomationToRunATaskOnThisHost',
              'Create an automation to run a task on this host.'
            )}
          </Text>
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
                  accessibilityLabel={t(
                    'automations.mobile.runOnSchedule',
                    'Run {{name}} on schedule',
                    { name: automation.name }
                  )}
                  value={automation.enabled}
                  onValueChange={(enabled) => props.onToggle(row, enabled)}
                  disabled={props.disabled}
                />
              </View>
              <Text style={styles.meta}>
                {formatAutomationSchedule(automation.rrule)} · {automation.timezone}
              </Text>
              <Text style={styles.meta}>
                {automation.enabled
                  ? t('automations.mobile.nextDate', 'Next: {{date}}', {
                      date: automationDate(automation.nextRunAt, automation.timezone)
                    })
                  : t('automations.mobile.noNextScheduledRun', 'No next scheduled run')}
              </Text>
              <Text style={styles.meta}>
                {item.usageSummary?.lastRunStatus
                  ? t('automations.mobile.lastResult', 'Last: {{status}} · {{date}}', {
                      status: automationRunStatusLabel(item.usageSummary.lastRunStatus),
                      date: automationDate(item.usageSummary.lastRunAt)
                    })
                  : t('automations.mobile.latestResultNotReported', 'Latest result not reported')}
              </Text>
              <Text style={styles.meta}>
                {automation.runContext?.path ?? automation.projectId}
                {item.selector.kind === 'ssh'
                  ? t('automations.mobile.sshTarget', ' · SSH {{target}}', {
                      target: item.selector.targetId
                    })
                  : ''}
              </Text>
              {item.selector.kind === 'orphan' ? (
                <Text style={styles.error}>{automationOrphanIssueText(item.selector.issue)}</Text>
              ) : null}
            </View>
          )
        })
      )}
    </View>
  )
}
