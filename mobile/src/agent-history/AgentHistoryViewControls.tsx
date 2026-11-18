import { useMemo, useState } from 'react'
import { ScrollView } from 'react-native'
import { CalendarPlus, Clock, ListFilter, type LucideIcon } from 'lucide-react-native'
import { FilterChip } from '../components/nav-bar/FilterChip'
import { ActionSheetModal, type ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  AI_VAULT_AGENTS,
  aiVaultAgentLabel,
  type AiVaultAgent,
  type AiVaultSession,
  type AiVaultSort
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { styles } from './agent-history-styles'

type Props = {
  sessions: readonly AiVaultSession[]
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  onAgentsChange: (agents: readonly AiVaultAgent[]) => void
  onSortChange: (sort: AiVaultSort) => void
}

/** Desktop History's agent filter and sort, as two chips under the scope switch. */
export function AgentHistoryViewControls({
  sessions,
  agents,
  sort,
  onAgentsChange,
  onSortChange
}: Props) {
  const t = useMobileTranslation()
  const [sheet, setSheet] = useState<'agents' | 'sort' | null>(null)
  // Only agents with history here: desktop's full list is two dozen rows, most of them empty.
  const listedAgents = useMemo(() => {
    const present = new Set<AiVaultAgent>(sessions.map((session) => session.agent))
    return AI_VAULT_AGENTS.filter((agent) => present.has(agent) || !agents.includes(agent))
  }, [sessions, agents])
  const allAgents = AI_VAULT_AGENTS.every((agent) => agents.includes(agent))
  const shownAgents = listedAgents.filter((agent) => agents.includes(agent))
  const agentsLabel = allAgents
    ? t('agentHistory.viewControls.allAgents', 'All agents')
    : shownAgents.length === 0
      ? t('agentHistory.viewControls.noAgents', 'No agents')
      : shownAgents.length === 1
        ? aiVaultAgentLabel(shownAgents[0]!)
        : t('agentHistory.viewControls.agentCount', '{{count}} agents', {
            count: shownAgents.length
          })
  const sortOptions: { value: AiVaultSort; label: string; icon: LucideIcon }[] = [
    {
      value: 'updated',
      label: t('agentHistory.viewControls.lastUpdated', 'Last updated'),
      icon: Clock
    },
    {
      value: 'created',
      label: t('agentHistory.viewControls.created', 'Created'),
      icon: CalendarPlus
    }
  ]
  const sortLabel = sortOptions.find((option) => option.value === sort)?.label ?? ''

  const agentActions: ActionSheetAction[] = [
    {
      id: 'all',
      label: t('agentHistory.viewControls.allAgents', 'All agents'),
      icon: ListFilter,
      checked: allAgents,
      skipAutoClose: true,
      onPress: () => onAgentsChange(AI_VAULT_AGENTS)
    },
    ...listedAgents.map((agent): ActionSheetAction => ({
      id: agent,
      label: aiVaultAgentLabel(agent),
      renderIcon: () => <MobileAgentIcon agentId={agent} size={17} />,
      checked: agents.includes(agent),
      skipAutoClose: true,
      onPress: () =>
        onAgentsChange(
          agents.includes(agent)
            ? agents.filter((candidate) => candidate !== agent)
            : [...agents, agent]
        )
    }))
  ]
  const sortActions: ActionSheetAction[] = sortOptions.map((option) => ({
    id: option.value,
    label: option.label,
    icon: option.icon,
    checked: option.value === sort,
    onPress: () => onSortChange(option.value)
  }))

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.viewControls}
      >
        <FilterChip
          label={agentsLabel}
          menu
          active={!allAgents}
          onPress={() => setSheet('agents')}
          accessibilityLabel={t('agentHistory.viewControls.agentsLabel', 'Agents: {{agents}}', {
            agents: agentsLabel
          })}
        />
        <FilterChip
          label={sortLabel}
          menu
          onPress={() => setSheet('sort')}
          accessibilityLabel={t('agentHistory.viewControls.sortLabel', 'Sort sessions: {{sort}}', {
            sort: sortLabel
          })}
        />
      </ScrollView>
      <ActionSheetModal
        visible={sheet === 'agents'}
        title={t('agentHistory.viewControls.agents', 'Agents')}
        actions={agentActions}
        onClose={() => setSheet(null)}
      />
      <ActionSheetModal
        visible={sheet === 'sort'}
        title={t('agentHistory.viewControls.sort', 'Sort')}
        actions={sortActions}
        onClose={() => setSheet(null)}
      />
    </>
  )
}
