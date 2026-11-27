import { Plus, SlidersHorizontal } from 'lucide-react-native'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  AGENT_LIST_GROUP_BY_CHOICES,
  DEFAULT_AGENT_LIST_VIEW,
  type AgentListGroupBy,
  type AgentListView
} from '../../agents/agent-list-model'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { BottomSearchBar } from '../../components/nav-bar/BottomSearchBar'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { HostProfile } from '../../host-catalog/host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { SwitchRow } from '../../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { spacing } from '../../theme/mobile-theme'

type FilterProps = {
  hosts: readonly HostProfile[]
  /** null is every computer. */
  hostFilter: string | null
  view: AgentListView
  onHostFilterChange: (hostId: string | null) => void
  onViewChange: (view: AgentListView) => void
}

/** How many choices differ from the defaults; the filter button shows it. */
function agentsFilterCount(hostFilter: string | null, view: AgentListView): number {
  return [
    hostFilter !== null,
    view.groupBy !== DEFAULT_AGENT_LIST_VIEW.groupBy,
    view.unreadOnly !== DEFAULT_AGENT_LIST_VIEW.unreadOnly,
    view.showWorkers !== DEFAULT_AGENT_LIST_VIEW.showWorkers
  ].filter(Boolean).length
}

/** The Agents tab's bar above the tabs, like the workspace list's: filter, search, and + for new work. */
export function MobileHomeAgentsBottomBar({
  query,
  onQueryChange,
  onCoveredHeightChange,
  onNewWorkspace,
  ...filters
}: FilterProps & {
  query: string
  onQueryChange: (query: string) => void
  onCoveredHeightChange: (height: number) => void
  /** Absent while no computer is connected to start one on. */
  onNewWorkspace?: () => void
}) {
  const t = useMobileTranslation()
  const [showFilters, setShowFilters] = useState(false)
  const count = agentsFilterCount(filters.hostFilter, filters.view)
  return (
    <>
      <BottomSearchBar
        value={query}
        onChangeText={onQueryChange}
        placeholder={t('agents.search.placeholder', 'Search agents')}
        // The tab bar under it already keeps clear of the home indicator.
        bottomInset={0}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel:
            count === 0
              ? t('agents.filterSheet.title', 'Filter')
              : t('agents.filterSheet.activeLabel', 'Filter, {{count}} active', { count }),
          onPress: () => setShowFilters(true),
          badge: count
        }}
        primary={
          onNewWorkspace
            ? {
                icon: Plus,
                accessibilityLabel: t('home.bottomBar.newWorkspace', 'New workspace'),
                onPress: onNewWorkspace
              }
            : undefined
        }
        onCoveredHeightChange={onCoveredHeightChange}
      />
      <AgentsFilterSheet visible={showFilters} onClose={() => setShowFilters(false)} {...filters} />
    </>
  )
}

// Tasks' filter sheet: rows apply as they're tapped, Done closes.
function AgentsFilterSheet({
  visible,
  onClose,
  hosts,
  hostFilter,
  view,
  onHostFilterChange,
  onViewChange
}: FilterProps & { visible: boolean; onClose: () => void }) {
  const t = useMobileTranslation()
  const groupByLabels: Record<AgentListGroupBy, string> = {
    status: t('agents.groupBy.status', 'Status'),
    workspace: t('agents.groupBy.workspace', 'Workspace'),
    project: t('agents.groupBy.project', 'Project'),
    agent: t('agents.groupBy.agent', 'Agent'),
    desktop: t('agents.groupBy.computer', 'Computer')
  }
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={t('agents.filterSheet.title', 'Filter')}
          leading={{
            label: t('agents.filterSheet.reset', 'Reset'),
            onPress: () => {
              onHostFilterChange(null)
              onViewChange(DEFAULT_AGENT_LIST_VIEW)
            },
            disabled: agentsFilterCount(hostFilter, view) === 0
          }}
          trailing={{ label: t('agents.filterSheet.done', 'Done'), onPress: onClose }}
        />
      </View>
      {/* One computer has nothing to choose between. */}
      {hosts.length > 1 ? (
        <>
          <SectionHeader title={t('agents.filterSheet.computer', 'Computer')} first />
          <ListGroup>
            <ListRow
              title={t('agents.filterSheet.allComputers', 'All computers')}
              selected={hostFilter === null}
              accessibilityRole="radio"
              onPress={() => onHostFilterChange(null)}
            />
            {hosts.map((host) => (
              <ComputerRow
                key={host.id}
                host={host}
                selected={hostFilter === host.id}
                onPress={() => onHostFilterChange(host.id)}
              />
            ))}
          </ListGroup>
        </>
      ) : null}
      <SectionHeader title={t('agents.options.groupBy', 'Group by')} first={hosts.length <= 1} />
      <ListGroup>
        {AGENT_LIST_GROUP_BY_CHOICES.filter(
          // Grouping one computer's agents by computer is one group; keep it only while picked.
          (groupBy) => groupBy !== 'desktop' || hosts.length > 1 || view.groupBy === groupBy
        ).map((groupBy) => (
          <ListRow
            key={groupBy}
            title={groupByLabels[groupBy]}
            selected={view.groupBy === groupBy}
            accessibilityRole="radio"
            onPress={() => onViewChange({ ...view, groupBy })}
          />
        ))}
      </ListGroup>
      <SectionHeader title={t('agents.filterSheet.show', 'Show')} />
      <ListGroup>
        <SwitchRow
          label={t('agents.options.unreadOnly', 'Unread only')}
          value={view.unreadOnly}
          onChange={(unreadOnly) => onViewChange({ ...view, unreadOnly })}
        />
        <SwitchRow
          label={t('agents.filterSheet.workers', 'Workers')}
          accessibilityLabel={t('agents.options.showWorkers', 'Show worker agents')}
          value={view.showWorkers}
          onChange={(showWorkers) => onViewChange({ ...view, showWorkers })}
        />
      </ListGroup>
    </BottomDrawer>
  )
}

function ComputerRow(props: { host: HostProfile; selected: boolean; onPress: () => void }) {
  const title = useHostDisplay(props.host).title
  return (
    <ListRow
      title={title}
      selected={props.selected}
      accessibilityRole="radio"
      onPress={props.onPress}
    />
  )
}

const styles = StyleSheet.create({ header: { marginBottom: spacing.xs } })
