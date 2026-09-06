import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from 'react-native'
import { Play } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { AiVaultSessionDisplayTurn } from '../../../src/shared/ai-vault-session-display'
import type { MobileAgentHistorySection } from './agent-history-sections'
import type { MobileAgentHistoryCard } from './agent-history-session-card'
import { styles } from './agent-history-styles'

type Props = {
  sections: MobileAgentHistorySection[]
  refreshing: boolean
  showCurrentWorktreeBadges: boolean
  resumeActionStateBySessionId?: ReadonlyMap<string, { disabled: boolean; loading: boolean }>
  loadPreview: (sessionId: string) => Promise<AiVaultSessionDisplayTurn[]>
  onResume?: (sessionId: string) => void | Promise<void>
  onRefresh: () => void
}

export function MobileAgentSessionHistoryList({
  sections,
  refreshing,
  showCurrentWorktreeBadges,
  resumeActionStateBySessionId,
  loadPreview,
  onResume,
  onRefresh
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [previews, setPreviews] = useState<
    ReadonlyMap<string, readonly AiVaultSessionDisplayTurn[]>
  >(new Map())

  const toggleExpanded = useCallback(
    (id: string) => {
      if (expandedId === id) {
        setExpandedId(null)
        return
      }
      setExpandedId(id)
      if (previews.has(id)) {
        return
      }
      void loadPreview(id)
        .then((turns) => {
          setPreviews((current) => new Map(current).set(id, turns))
        })
        .catch(() => {
          setPreviews((current) => new Map(current).set(id, []))
        })
    },
    [expandedId, loadPreview, previews]
  )

  const renderItem = useCallback(
    ({ item }: { item: MobileAgentHistoryCard }) => (
      <AgentHistoryCardRow
        card={item}
        expanded={expandedId === item.id}
        previewTurns={previews.get(item.id) ?? []}
        showCurrentWorktreeBadge={showCurrentWorktreeBadges}
        resumeActionState={resumeActionStateBySessionId?.get(item.id)}
        onResume={onResume}
        onPress={() => toggleExpanded(item.id)}
      />
    ),
    [
      expandedId,
      onResume,
      previews,
      resumeActionStateBySessionId,
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
  previewTurns,
  showCurrentWorktreeBadge,
  resumeActionState,
  onResume,
  onPress
}: {
  card: MobileAgentHistoryCard
  expanded: boolean
  previewTurns: readonly AiVaultSessionDisplayTurn[]
  showCurrentWorktreeBadge: boolean
  resumeActionState?: { disabled: boolean; loading: boolean }
  onResume?: (sessionId: string) => void | Promise<void>
  onPress: () => void
}) {
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
        {onResume ? (
          <Pressable
            style={({ pressed }) => [
              styles.resumeButton,
              resumeActionState?.disabled && styles.resumeButtonDisabled,
              pressed && !resumeActionState?.disabled && styles.resumeButtonPressed
            ]}
            onPress={(event) => {
              event.stopPropagation()
              if (!resumeActionState?.disabled) {
                void onResume(card.id)
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
