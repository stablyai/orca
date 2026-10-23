import { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { SectionHeader } from '../components/ui/SectionHeader'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
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
  /** Tells the nav bar to draw its hairline once rows pass under it. */
  onScrolledChange?: (scrolled: boolean) => void
}

export function MobileAgentSessionHistoryList({
  sections,
  sessionsById,
  refreshing,
  showCurrentWorktreeBadges,
  resumeActionStateBySessionId,
  onResume,
  onRefresh,
  onScrolledChange
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
        <SectionHeader
          title={section.label}
          count={section.data.length}
          first={section === sections[0]}
        />
      )}
      renderItem={renderItem}
      ItemSeparatorComponent={RowSeparator}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      onScroll={
        onScrolledChange
          ? (event) => onScrolledChange(event.nativeEvent.contentOffset.y > 0)
          : undefined
      }
      scrollEventThrottle={32}
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
  const resumable = session !== null && onResume !== undefined
  const resumeDisabled = resumeActionState?.disabled === true
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={card.title}
      accessibilityHint={expanded ? 'Hides the recent messages.' : 'Shows the recent messages.'}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            pressed && styles.rowPressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.leading}>
            <MobileAgentIcon agentId={card.agent} size={18} />
          </View>
          <View style={styles.main}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {card.title}
              </Text>
              {card.timeAgo ? <Text style={styles.timeAgo}>{card.timeAgo}</Text> : null}
              <View
                style={[
                  expanded ? styles.chevronExpanded : styles.chevronCollapsed,
                  slideTransition
                ]}
              >
                <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
              </View>
            </View>
            {card.lastMessage ? (
              <Text style={styles.lastMessage} numberOfLines={expanded ? undefined : 2}>
                {card.lastMessage}
              </Text>
            ) : null}
            {showCurrentWorktreeBadge && card.isCurrentWorktree ? (
              <View style={styles.badgeLine}>
                <Badge label="This workspace" tone="blue" />
              </View>
            ) : null}
            <View style={styles.metaRow}>
              <Text style={styles.metaText} numberOfLines={1}>
                {card.agentLabel} · {card.messageCount}{' '}
                {card.messageCount === 1 ? 'message' : 'messages'}
              </Text>
              <View style={styles.metaSpacer} />
              {resumable ? (
                <Button
                  label="Resume"
                  size="compact"
                  busy={resumeActionState?.loading === true}
                  disabled={resumeDisabled}
                  onPress={() => {
                    if (!resumeDisabled) {
                      void onResume(session)
                    }
                  }}
                  accessibilityLabel="Resume agent session"
                  style={styles.resume}
                />
              ) : null}
            </View>
            <Collapsible open={expanded && session !== null}>
              {session ? <PreviewTurns card={card} session={session} /> : null}
            </Collapsible>
          </View>
        </View>
      )}
    </Pressable>
  )
}

// Mounted only while its card is open or closing, so a closed row reads no turns.
function PreviewTurns({
  card,
  session
}: {
  card: MobileAgentHistoryCard
  session: AiVaultSession
}) {
  const previewTurns = useMemo(
    () => recentSessionConversationTurns(session, PREVIEW_TURN_LIMIT),
    [session]
  )
  if (previewTurns.length === 0) {
    return null
  }
  return (
    <View style={styles.preview}>
      {previewTurns.map((turn, index) => (
        <View key={`${card.id}-turn-${index}`} style={styles.previewTurn}>
          <Text style={styles.previewRole}>{turn.role === 'user' ? 'You' : card.agentLabel}</Text>
          <Text style={styles.previewText}>{turn.text}</Text>
        </View>
      ))}
    </View>
  )
}

function RowSeparator() {
  return <View style={styles.separator} />
}
