import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  automationRunEventSourceKey,
  sayAutomationRunEnglish
} from '../../../src/shared/automations/automation-run-row-words'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { colors, pressedStyle } from '../theme/mobile-theme'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'
import { AutomationButton, AutomationChoice } from './AutomationControls'
import type { AutomationRunObservation } from './use-automation-runs'
import {
  automationDate,
  automationRunStatusLabel,
  runMatchesOutcome
} from './automation-run-presentation'
import { automationStyles as styles } from './automation-styles'

export function AutomationRunList(props: {
  history: AutomationRunObservation
  connected: boolean
  outcome?: string
  recent?: boolean
  onSelect: (run: MobileAutomationRun) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const history = props.history
  const matches = history.runs.filter((run) => runMatchesOutcome(run, props.outcome ?? 'all'))
  const visible = props.recent ? matches.slice(0, 3) : matches
  return (
    <View style={styles.stack}>
      {history.error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {history.error}
          </Text>
          <AutomationButton
            label={t('automations.mobile.retryHistory', 'Retry history')}
            onPress={history.reload}
            disabled={!props.connected || history.loading}
          />
        </>
      ) : null}
      {history.loading && history.runs.length === 0 ? (
        <Text style={styles.meta}>{t('automations.mobile.loadingRuns', 'Loading runs…')}</Text>
      ) : null}
      {!history.loading && visible.length === 0 ? (
        <Text style={styles.meta}>
          {history.cursor
            ? t(
                'automations.mobile.noMatchingRunsInTheLoadedHistoryLoadMoreToContinue',
                'No matching runs in the loaded history. Load more to continue.'
              )
            : t('automations.mobile.noMatchingRunsYet', 'No matching runs yet.')}
        </Text>
      ) : null}
      {visible.map((run) => (
        <Pressable
          key={run.id}
          accessibilityRole="button"
          accessibilityLabel={t(
            'automations.mobile.runSummary',
            '{{title}}, {{status}}, {{date}}',
            {
              title: run.title,
              status: automationRunStatusLabel(run.status),
              date: automationDate(run.scheduledFor)
            }
          )}
          onPress={() => props.onSelect(run)}
          style={({ pressed }) => [styles.card, pressed && pressedStyle]}
        >
          <View style={styles.row}>
            <Text style={[styles.heading, styles.grow]}>{run.title}</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </View>
          <Text style={styles.text}>{automationRunStatusLabel(run.status)}</Text>
          <Text style={styles.meta}>
            {automationDate(run.scheduledFor)} ·{' '}
            {run.trigger === 'manual'
              ? t('automations.mobile.runNow', 'Run now')
              : run.trigger === 'event'
                ? sayAutomationRunEnglish(automationRunEventSourceKey(run))
                : t('automations.mobile.scheduled', 'Scheduled')}
          </Text>
          {run.workspaceDisplayName ? (
            <Text style={styles.meta}>{run.workspaceDisplayName}</Text>
          ) : null}
        </Pressable>
      ))}
      {!props.recent && history.cursor ? (
        <AutomationButton
          label={
            history.loading
              ? t('automations.mobile.loading', 'Loading…')
              : t('automations.mobile.loadMoreRuns', 'Load more runs')
          }
          onPress={history.loadMore}
          disabled={history.loading || !props.connected}
        />
      ) : null}
    </View>
  )
}

/** The Runs tab: which automation and outcome to show, then the runs that match. */
export function AutomationRunsView(props: {
  rows: readonly MobileAutomationRow[]
  automationId: string
  onAutomation: (automationId: string) => void
  outcome: string
  onOutcome: (outcome: string) => void
  history: AutomationRunObservation
  connected: boolean
  onSelect: (run: MobileAutomationRun) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.stack}>
      <AutomationChoice
        label={t('automations.mobile.automation', 'Automation')}
        value={props.automationId}
        options={[
          { value: '', label: t('automations.mobile.allAutomations', 'All automations') },
          ...props.rows.map((entry) => ({
            value: entry.automation.id,
            label: entry.automation.name
          }))
        ]}
        onSelect={props.onAutomation}
      />
      <AutomationChoice
        label={t('automations.mobile.outcome', 'Outcome')}
        value={props.outcome}
        options={[
          { value: 'all', label: t('automations.mobile.allOutcomes', 'All outcomes') },
          { value: 'active', label: t('automations.mobile.inProgress', 'In progress') },
          { value: 'completed', label: t('automations.mobile.completed', 'Completed') },
          {
            value: 'dispatch_failed',
            label: t('automations.mobile.couldNotStart', 'Could not start')
          },
          { value: 'skipped', label: t('automations.mobile.skipped', 'Skipped') }
        ]}
        onSelect={props.onOutcome}
      />
      <AutomationRunList
        connected={props.connected}
        history={props.history}
        outcome={props.outcome}
        onSelect={props.onSelect}
      />
    </View>
  )
}
