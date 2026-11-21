import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SlidersHorizontal } from '../components/icons/app-icons'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  AI_VAULT_AGENTS,
  aiVaultAgentLabel,
  type AiVaultAgent,
  type AiVaultSession,
  type AiVaultSort
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'

// Desktop History's defaults: every agent, most recently updated first.
export const AGENT_HISTORY_DEFAULT_SORT: AiVaultSort = 'updated'

export function agentHistoryShowsEveryAgent(agents: readonly AiVaultAgent[]): boolean {
  return AI_VAULT_AGENTS.every((agent) => agents.includes(agent))
}

/** How many settings differ from the defaults; the bottom bar's filter button shows it. */
function agentHistoryFilterCount(agents: readonly AiVaultAgent[], sort: AiVaultSort): number {
  return (
    (agentHistoryShowsEveryAgent(agents) ? 0 : 1) + (sort === AGENT_HISTORY_DEFAULT_SORT ? 0 : 1)
  )
}

type FilterProps = {
  sessions: readonly AiVaultSession[]
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  onAgentsChange: (agents: readonly AiVaultAgent[]) => void
  onSortChange: (sort: AiVaultSort) => void
}

/** History's bar under the thumb, like the workspace list's: Filter & sort beside search. */
export function AgentHistoryBottomBar({
  query,
  onQueryChange,
  bottomInset,
  onCoveredHeightChange,
  ...filters
}: FilterProps & {
  query: string
  onQueryChange: (query: string) => void
  bottomInset: number
  onCoveredHeightChange: (height: number) => void
}) {
  const t = useMobileTranslation()
  const [showFilters, setShowFilters] = useState(false)
  const count = agentHistoryFilterCount(filters.agents, filters.sort)
  return (
    <>
      <BottomSearchBar
        value={query}
        onChangeText={onQueryChange}
        placeholder={t('agentHistory.panel.placeholder', 'Search sessions, repo:, path:')}
        bottomInset={bottomInset}
        leading={{
          icon: SlidersHorizontal,
          accessibilityLabel:
            count === 0
              ? t('agentHistory.filterSheet.title', 'Filter & sort')
              : t('agentHistory.filterSheet.activeLabel', 'Filter & sort, {{count}} active', {
                  count
                }),
          onPress: () => setShowFilters(true),
          badge: count
        }}
        onCoveredHeightChange={onCoveredHeightChange}
      />
      <AgentHistoryFilterSheet
        visible={showFilters}
        onClose={() => setShowFilters(false)}
        {...filters}
      />
    </>
  )
}

// Tasks' Filter & display sheet: rows apply as they're tapped, Done closes.
function AgentHistoryFilterSheet({
  visible,
  onClose,
  sessions,
  agents,
  sort,
  onAgentsChange,
  onSortChange
}: FilterProps & { visible: boolean; onClose: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Only agents with history here: desktop's full list is two dozen rows, most of them empty.
  const listedAgents = useMemo(() => {
    const present = new Set<AiVaultAgent>(sessions.map((session) => session.agent))
    return AI_VAULT_AGENTS.filter((agent) => present.has(agent) || !agents.includes(agent))
  }, [sessions, agents])
  const sortOptions: { value: AiVaultSort; label: string }[] = [
    { value: 'updated', label: t('agentHistory.viewControls.lastUpdated', 'Last updated') },
    { value: 'created', label: t('agentHistory.viewControls.created', 'Created') }
  ]
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={t('agentHistory.filterSheet.title', 'Filter & sort')}
          leading={{
            label: t('agentHistory.filterSheet.reset', 'Reset'),
            onPress: () => {
              onAgentsChange(AI_VAULT_AGENTS)
              onSortChange(AGENT_HISTORY_DEFAULT_SORT)
            },
            disabled: agentHistoryFilterCount(agents, sort) === 0
          }}
          trailing={{ label: t('agentHistory.filterSheet.done', 'Done'), onPress: onClose }}
        />
      </View>
      <SectionHeader title={t('agentHistory.filterSheet.sortBy', 'Sort by')} first />
      <ListGroup>
        {sortOptions.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            selected={option.value === sort}
            onPress={() => onSortChange(option.value)}
          />
        ))}
      </ListGroup>
      <SectionHeader title={t('agentHistory.viewControls.agents', 'Agents')} />
      <ListGroup>
        <ListRow
          title={t('agentHistory.viewControls.allAgents', 'All agents')}
          selected={agentHistoryShowsEveryAgent(agents)}
          accessibilityRole="checkbox"
          onPress={() => onAgentsChange(AI_VAULT_AGENTS)}
        />
        {listedAgents.map((agent) => (
          <ListRow
            key={agent}
            title={aiVaultAgentLabel(agent)}
            leading={<MobileAgentIcon agentId={agent} size={17} />}
            selected={agents.includes(agent)}
            accessibilityRole="checkbox"
            onPress={() =>
              onAgentsChange(
                agents.includes(agent)
                  ? agents.filter((candidate) => candidate !== agent)
                  : [...agents, agent]
              )
            }
          />
        ))}
      </ListGroup>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({ header: { marginBottom: spacing.xs } })
