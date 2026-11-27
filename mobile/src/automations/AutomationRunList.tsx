import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { History, SlidersHorizontal } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import {
  automationRunEventSourceKey,
  sayAutomationRunEnglish
} from '../../../src/shared/automations/automation-run-row-words'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { MobileLoadErrorState, MobileStateView } from '../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SettingsEmptyRow, SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { useNow } from '../hooks/use-now'
import { mobileUsageLimitClock } from '../bots/mobile-usage-limit-copy'
import { spacing } from '../theme/mobile-theme'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'
import type { AutomationRunObservation, AutomationRunScope } from './use-automation-runs'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automations/ownership/automation-owner-precondition'
import { automationRunStatusLabel, runMatchesOutcome } from './automation-run-presentation'

function AutomationRunRow(props: { run: MobileAutomationRun; now: number; onPress: () => void }) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { run } = props
  const status = automationRunStatusLabel(run.status, t)
  const time = mobileUsageLimitClock(run.startedAt ?? run.scheduledFor, props.now, intlLocale)
  const trigger =
    run.trigger === 'manual'
      ? t('automations.mobile.runNow', 'Run now')
      : run.trigger === 'event'
        ? sayAutomationRunEnglish(automationRunEventSourceKey(run))
        : t('automations.mobile.scheduled', 'Scheduled')
  return (
    <ListRow
      title={run.title}
      subtitle={`${status} · ${trigger}`}
      subtitleLines={1}
      value={time}
      navigates
      accessibilityLabel={t('automations.mobile.runSummary', '{{title}}, {{status}}, {{date}}', {
        title: run.title,
        status,
        date: time
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
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const now = useNow(60_000)
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
          <AutomationRunRow key={run.id} run={run} now={now} onPress={() => props.onSelect(run)} />
        ))}
      </ListGroup>
    </>
  )
}

/** The Runs tab: the runs that match the bar's search and filters. */
export function AutomationRunsView(props: {
  query: string
  outcome: string
  history: AutomationRunObservation
  connected: boolean
  onSelect: (run: MobileAutomationRun) => void
}) {
  const t = useMobileTranslation()
  const now = useNow(60_000)
  const { history } = props
  const query = props.query.trim().toLocaleLowerCase()
  const visible = history.runs.filter(
    (run) =>
      runMatchesOutcome(run, props.outcome) &&
      (!query || run.title.toLocaleLowerCase().includes(query))
  )
  const loadMore =
    history.cursor && props.connected
      ? {
          label: t('automations.mobile.loadMoreRuns', 'Load more runs'),
          onPress: history.loadMore
        }
      : null
  if (history.error && visible.length === 0) {
    return (
      <MobileLoadErrorState
        error={history.error}
        onRetry={props.connected && !history.loading ? history.reload : null}
      />
    )
  }
  if (history.loading && visible.length === 0) {
    return <MobileStateView loading title={t('automations.mobile.loadingRuns', 'Loading runs…')} />
  }
  if (visible.length === 0) {
    return (
      <MobileStateView
        icon={History}
        title={
          history.runs.length > 0
            ? t('automations.mobile.noMatchingRuns', 'No matching runs')
            : t('automations.mobile.noRunsYet', 'No runs yet')
        }
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
    )
  }
  return (
    <>
      {history.error ? <SettingsNote error>{history.error}</SettingsNote> : null}
      <SettingsSection first>
        {visible.map((run) => (
          <AutomationRunRow key={run.id} run={run} now={now} onPress={() => props.onSelect(run)} />
        ))}
        {history.cursor ? (
          <ListRow
            title={t('automations.mobile.loadMoreRuns', 'Load more runs')}
            accent
            disabled={!props.connected}
            busy={history.loading}
            onPress={history.loadMore}
          />
        ) : null}
      </SettingsSection>
    </>
  )
}

/** The Runs tab's search, outcome and automation, and how much of the screen its bar covers. */
export function useAutomationRunFilters(rows: readonly MobileAutomationRow[]) {
  const [scope, setScope] = useState<AutomationRunScope>(null)
  const [outcome, setOutcome] = useState('all')
  const [query, setQuery] = useState('')
  const [barHeight, setBarHeight] = useState(0)
  const selectAutomation = (id: string) => {
    const selected = rows.find((entry) => entry.automation.id === id)
    if (!id) {
      setScope(null)
    } else if (selected) {
      setScope({
        automationId: id,
        expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
      })
    }
  }
  return { scope, selectAutomation, outcome, setOutcome, query, setQuery, barHeight, setBarHeight }
}
type RunFilters = ReturnType<typeof useAutomationRunFilters>

/** The Runs tab's bar under the thumb: search by title beside the filter button, as on History. */
export function AutomationRunsBar(props: {
  filters: RunFilters
  rows: readonly MobileAutomationRow[]
}) {
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)
  const { filters } = props
  const count = (filters.scope ? 1 : 0) + (filters.outcome === 'all' ? 0 : 1)
  return (
    <>
      <BottomSearchBar
        value={filters.query}
        onChangeText={filters.setQuery}
        placeholder={t('automations.mobile.searchRuns', 'Search runs')}
        bottomInset={insets.bottom}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel:
            count === 0
              ? t('automations.mobile.filter', 'Filter')
              : t('automations.mobile.filterActive', 'Filter, {{count}} active', { count }),
          onPress: () => setOpen(true),
          badge: count
        }}
        onCoveredHeightChange={filters.setBarHeight}
      />
      <AutomationRunsFilterSheet
        visible={open}
        onClose={() => setOpen(false)}
        rows={props.rows}
        filters={filters}
      />
    </>
  )
}

// History's filter sheet: rows apply as they're tapped, Done closes.
function AutomationRunsFilterSheet(props: {
  visible: boolean
  onClose: () => void
  rows: readonly MobileAutomationRow[]
  filters: RunFilters
}) {
  const { filters } = props
  const t = useMobileTranslation()
  const outcomes = [
    { value: 'all', label: t('automations.mobile.allOutcomes', 'All outcomes') },
    { value: 'active', label: t('automations.mobile.inProgress', 'In progress') },
    { value: 'completed', label: t('automations.mobile.completed', 'Completed') },
    { value: 'dispatch_failed', label: t('automations.mobile.couldNotStart', 'Could not start') },
    { value: 'skipped', label: t('automations.mobile.skipped', 'Skipped') }
  ]
  const automations = [
    { value: '', label: t('automations.mobile.allAutomations', 'All automations') },
    ...props.rows.map((entry) => ({ value: entry.automation.id, label: entry.automation.name }))
  ]
  return (
    <BottomDrawer visible={props.visible} onClose={props.onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={t('automations.mobile.filter', 'Filter')}
          leading={{
            label: t('automations.mobile.reset', 'Reset'),
            onPress: () => {
              filters.selectAutomation('')
              filters.setOutcome('all')
            },
            disabled: !filters.scope && filters.outcome === 'all'
          }}
          trailing={{ label: t('automations.mobile.done', 'Done'), onPress: props.onClose }}
        />
      </View>
      <SectionHeader title={t('automations.mobile.outcome', 'Outcome')} first />
      <ListGroup>
        {outcomes.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            selected={option.value === filters.outcome}
            onPress={() => filters.setOutcome(option.value)}
          />
        ))}
      </ListGroup>
      <SectionHeader title={t('automations.mobile.automation', 'Automation')} />
      <ListGroup>
        {automations.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            selected={option.value === (filters.scope?.automationId ?? '')}
            onPress={() => filters.selectAutomation(option.value)}
          />
        ))}
      </ListGroup>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({ header: { marginBottom: spacing.xs } })
