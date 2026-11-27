import { useCallback } from 'react'
import { RefreshControl, SectionList, View } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme, useMobileColors } from '../theme/use-mobile-color-scheme'
import { SectionHeader } from '../components/list/ListGroup'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { MobileAgentHistorySection } from './agent-history-sections'
import type {
  MobileAgentHistoryCard,
  MobileAgentHistoryResumeActionState
} from './agent-history-session-card'
import { AgentHistorySessionRow } from './AgentHistorySessionRow'
import { stylesSheet } from './agent-history-styles'
import { useThemedStyles } from '../theme/themed-styles'

type Props = {
  sections: MobileAgentHistorySection[]
  sessionsById: ReadonlyMap<string, AiVaultSession>
  refreshing: boolean
  showCurrentWorktreeBadges: boolean
  resumeActionStateBySessionId?: ReadonlyMap<string, MobileAgentHistoryResumeActionState>
  onResume?: (session: AiVaultSession) => void | Promise<void>
  primaryAction?: 'resume' | 'handoff'
  onLongPress?: (session: AiVaultSession) => void
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
  primaryAction,
  onLongPress,
  onRefresh,
  bottomPadding = 0
}: Props) {
  const colors = useMobileColors()
  const colorScheme = useMobileColorScheme()

  const renderItem = useCallback(
    ({ item }: { item: MobileAgentHistoryCard }) => (
      <AgentHistorySessionRow
        card={item}
        session={sessionsById.get(item.id) ?? null}
        showCurrentWorktreeBadge={showCurrentWorktreeBadges}
        resumeActionState={resumeActionStateBySessionId?.get(item.id)}
        onResume={onResume}
        primaryAction={primaryAction}
        onLongPress={onLongPress}
      />
    ),
    [
      onLongPress,
      primaryAction,
      onResume,
      resumeActionStateBySessionId,
      sessionsById,
      showCurrentWorktreeBadges
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
  const styles = useThemedStyles(stylesSheet)
  return <View style={styles.separator} />
}
