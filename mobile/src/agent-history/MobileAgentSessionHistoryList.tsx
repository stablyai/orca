import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from 'react-native'
import { Play } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { recentSessionConversationTurns } from '../../../src/shared/ai-vault-session-display'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { MobileAgentHistorySection } from './agent-history-sections'
import type { MobileAgentHistoryCard } from './agent-history-session-card'
import { styles } from './agent-history-styles'

// Lazy-render at most this many preview turns when a card is tapped — the
// scanner already bounds preview text, but rendering them only on tap keeps the
// list cheap.
const PREVIEW_TURN_LIMIT = 5

type Props = {
  sections: MobileAgentHistorySection[]
  sessionsById: ReadonlyMap<string, AiVaultSession>
  refreshing: boolean
  showCurrentWorktreeBadges: boolean
  resumeActionStateBySessionId?: ReadonlyMap<string, { disabled: boolean; loading: boolean }>
  onResume?: (session: AiVaultSession) => void | Promise<void>
  onRefresh: () => void
}

export function MobileAgentSessionHistoryList({
  sections,
  sessionsById,
  refreshing,
  showCurrentWorktreeBadges,
  resumeActionStateBySessionId,
  onResume,
  onRefresh
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: MobileAgentHistoryCard }) => (
      <AgentHistoryCardRow
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
      keyExtractor={(card) => card.id}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.groupHeader}>
          <Text style={styles.groupHeaderText} numberOfLines={1}>
            {section.label}
          </Text>
          <Text style={styles.groupHeaderCount}>{section.data.length}</Text>
        </View>
      )}
      renderItem={renderItem}
    />
  )
}

function AgentHistoryCardRow({
  card,
  expanded,
  session,
  showCurrentWorktreeBadge,
  resumeActionState,
  onResume,
  onPress
}: {
  card: MobileAgentHistoryCard
  expanded: boolean
  session: AiVaultSession | null
  showCurrentWorktreeBadge: boolean
  resumeActionState?: { disabled: boolean; loading: boolean }
  onResume?: (session: AiVaultSession) => void | Promise<void>
  onPress: () => void
}) {
  const previewTurns = useMemo(
    () => (expanded && session ? recentSessionConversationTurns(session, PREVIEW_TURN_LIMIT) : []),
    [expanded, session]
  )

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
    >
      <View style={styles.cardTopRow}>
        <MobileAgentIcon agentId={card.agent} size={16} />
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        {card.timeAgo ? <Text style={styles.cardTimeAgo}>{card.timeAgo}</Text> : null}
      </View>
      {card.lastMessage ? (
        <Text style={styles.cardLastMessage} numberOfLines={expanded ? undefined : 2}>
          {card.lastMessage}
        </Text>
      ) : null}
      <View style={styles.cardMetaRow}>
        <Text style={styles.cardMetaText}>{card.agentLabel}</Text>
        <Text style={styles.cardMetaText}>
          {card.messageCount} {card.messageCount === 1 ? 'message' : 'messages'}
        </Text>
        {showCurrentWorktreeBadge && card.isCurrentWorktree ? (
          <View style={styles.currentBadge}>
            <Text style={styles.currentBadgeText}>current worktree</Text>
          </View>
        ) : null}
        {session && onResume ? (
          <Pressable
            style={({ pressed }) => [
              styles.resumeButton,
              resumeActionState?.disabled && styles.resumeButtonDisabled,
              pressed && !resumeActionState?.disabled && styles.resumeButtonPressed
            ]}
            onPress={(event) => {
              event.stopPropagation()
              if (!resumeActionState?.disabled) {
                void onResume(session)
              }
            }}
            disabled={resumeActionState?.disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Resume agent session"
          >
            {resumeActionState?.loading ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Play size={17} color={colors.textPrimary} strokeWidth={2.4} />
            )}
          </Pressable>
        ) : null}
      </View>
      {expanded && previewTurns.length > 0 ? (
        <View style={styles.preview}>
          {previewTurns.map((turn, index) => (
            <View key={`${card.id}-turn-${index}`} style={styles.previewTurn}>
              <Text style={styles.previewRole}>{turn.role}</Text>
              <Text style={styles.previewText}>{turn.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  )
}
