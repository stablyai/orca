import { useCallback, useState } from 'react'
import { RefreshControl, SectionList, View } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SectionHeader } from '../components/list/SectionHeader'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { MobileAgentHistorySection } from './agent-history-sections'
import type {
  MobileAgentHistoryCard,
  MobileAgentHistoryResumeActionState
} from './agent-history-session-card'
import { AgentHistorySessionRow } from './AgentHistorySessionRow'
import { styles } from './agent-history-styles'

type Props = {
  sections: MobileAgentHistorySection[]
  sessionsById: ReadonlyMap<string, AiVaultSession>
  refreshing: boolean
  showCurrentWorktreeBadges: boolean
  resumeActionStateBySessionId?: ReadonlyMap<string, MobileAgentHistoryResumeActionState>
  onResume?: (session: AiVaultSession) => void | Promise<void>
  onRefresh: () => void
  /** Clears the bottom search bar floating over the list. */
  bottomPadding?: number
}

export function MobileAgentSessionHistoryList({
  sections,
  sessionsById,
  refreshing,
  showCurrentWorktreeBadges,
  resumeActionStateBySessionId,
  onResume,
  onRefresh,
  bottomPadding = 0
}: Props) {
  const colorScheme = useMobileColorScheme()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: MobileAgentHistoryCard }) => (
      <AgentHistorySessionRow
        card={item}
        expanded={expandedId === item.id}
        session={sessionsById.get(item.id) ?? null}
        showCurrentWorktreeBadge={showCurrentWorktreeBadges}
        resumeActionState={resumeActionStateBySessionId?.get(item.id)}
        onResume={onResume}
        onPress={() => toggleExpanded(item.id)}
      />
    ),
    [
      expandedId,
      onResume,
      resumeActionStateBySessionId,
      sessionsById,
      showCurrentWorktreeBadges,
      toggleExpanded
    ]
  )

  return (
    <SectionList
      sections={sections}
      extraData={colorScheme}
      keyExtractor={(card) => card.id}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingBottom: spacing.xl + bottomPadding }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
      renderSectionHeader={({ section }) => (
        <SectionHeader
          title={section.label}
          trailing={String(section.data.length)}
          first={section === sections[0]}
        />
      )}
      renderItem={renderItem}
      ItemSeparatorComponent={RowSeparator}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    />
  )
}

function RowSeparator() {
  return <View style={styles.separator} />
}
