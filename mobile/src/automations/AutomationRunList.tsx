import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  automationRunEventSourceKey,
  sayAutomationRunEnglish
} from '../../../src/shared/automations/automation-run-row-words'
import { History } from '../components/icons/app-icons'
import { MobileLoadErrorState, MobileStateView } from '../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SettingsEmptyRow, SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'
import { AutomationChoiceRow } from './AutomationControls'
import type { AutomationRunObservation } from './use-automation-runs'
import {
  automationDate,
  automationRunStatusLabel,
  runMatchesOutcome
} from './automation-run-presentation'

function AutomationRunRow(props: { run: MobileAutomationRun; onPress: () => void }) {
  const t = useMobileTranslation()
  const { run } = props
  const status = automationRunStatusLabel(run.status)
  const date = automationDate(run.scheduledFor)
  const trigger =
    run.trigger === 'manual'
      ? t('automations.mobile.runNow', 'Run now')
      : run.trigger === 'event'
        ? sayAutomationRunEnglish(automationRunEventSourceKey(run))
        : t('automations.mobile.scheduled', 'Scheduled')
  return (
    <ListRow
      title={run.title}
      subtitle={`${status} · ${date} · ${trigger}`}
      subtitleLines={1}
      navigates
      accessibilityLabel={t('automations.mobile.runSummary', '{{title}}, {{status}}, {{date}}', {
        title: run.title,
        status,
        date
      })}
      onPress={props.onPress}
    />
  )
}

/** The detail's last three runs, as rows under its Recent runs header. */
export function AutomationRecentRuns(props: {
  history: AutomationRunObservation
  connected: boolean
  onSelect: (run: MobileAutomationRun) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { history } = props
  const recent = history.runs.slice(0, 3)
  return (
    <>
      <SectionHeader title={t('automations.mobile.recentRuns', 'Recent runs')} />
      <ListGroup>
        {history.error ? (
          <ListRow
            title={t('automations.mobile.retryHistory', 'Retry history')}
            subtitle={history.error}
            subtitleColor={colors.statusRed}
            disabled={!props.connected}
            busy={history.loading}
            onPress={history.reload}
          />
        ) : null}
        {recent.length === 0 && !history.error ? (
          <SettingsEmptyRow>
            {history.loading
              ? t('automations.mobile.loadingRuns', 'Loading runs…')
              : t('automations.mobile.noRunsYet', 'No runs yet')}
          </SettingsEmptyRow>
        ) : null}
        {recent.map((run) => (
          <AutomationRunRow key={run.id} run={run} onPress={() => props.onSelect(run)} />
        ))}
      </ListGroup>
    </>
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
  const { history } = props
  const visible = history.runs.filter((run) => runMatchesOutcome(run, props.outcome))
  const loadMore =
    history.cursor && props.connected
      ? {
          label: t('automations.mobile.loadMoreRuns', 'Load more runs'),
          onPress: history.loadMore
        }
      : null
  return (
    <>
      <ListGroup>
        <AutomationChoiceRow
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
        <AutomationChoiceRow
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
      </ListGroup>
      {history.error && visible.length === 0 ? (
        <MobileLoadErrorState
          error={history.error}
          onRetry={props.connected && !history.loading ? history.reload : null}
        />
      ) : history.loading && visible.length === 0 ? (
        <MobileStateView loading title={t('automations.mobile.loadingRuns', 'Loading runs…')} />
      ) : visible.length === 0 ? (
        <MobileStateView
          icon={History}
          title={t('automations.mobile.noRunsYet', 'No runs yet')}
          message={
            history.cursor
              ? t(
                  'automations.mobile.noMatchingRunsInTheLoadedHistoryLoadMoreToContinue',
                  'No matching runs in the loaded history. Load more to continue.'
                )
              : null
          }
          action={loadMore}
        />
      ) : (
        <>
          {history.error ? <SettingsNote error>{history.error}</SettingsNote> : null}
          <SettingsSection>
            {visible.map((run) => (
              <AutomationRunRow key={run.id} run={run} onPress={() => props.onSelect(run)} />
            ))}
            {history.cursor ? (
              <ListRow
                title={t('automations.mobile.loadMoreRuns', 'Load more runs')}
                disabled={!props.connected}
                busy={history.loading}
                onPress={history.loadMore}
              />
            ) : null}
          </SettingsSection>
        </>
      )}
    </>
  )
}
