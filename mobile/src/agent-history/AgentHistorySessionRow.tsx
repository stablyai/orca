import { useMemo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronDown, Play } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AutoHeight } from '../components/AutoHeight'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { recentSessionConversationTurns } from '../../../src/shared/ai-vault-session-display'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type {
  MobileAgentHistoryCard,
  MobileAgentHistoryResumeActionState
} from './agent-history-session-card'
import { styles } from './agent-history-styles'

// Render bounded preview turns only on row tap to keep list cheap.
const PREVIEW_TURN_LIMIT = 5

type Props = {
  card: MobileAgentHistoryCard
  expanded: boolean
  session: AiVaultSession | null
  showCurrentWorktreeBadge: boolean
  resumeActionState?: MobileAgentHistoryResumeActionState
  onResume?: (session: AiVaultSession) => void | Promise<void>
  onPress: () => void
}

export function AgentHistorySessionRow({
  card,
  expanded,
  session,
  showCurrentWorktreeBadge,
  resumeActionState,
  onResume,
  onPress
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const count = card.messageCount
  const messages =
    count === 1
      ? t('agentHistory.sessionHistoryList.messages_one', '{{count}} message', { count })
      : t('agentHistory.sessionHistoryList.messages_other', '{{count}} messages', { count })
  const resumeDisabled = resumeActionState?.disabled === true

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={card.title}
      accessibilityHint={
        expanded
          ? t('agentHistory.sessionHistoryList.hidePreview', 'Hides the recent messages.')
          : t('agentHistory.sessionHistoryList.showPreview', 'Shows the recent messages.')
      }
    >
      {({ pressed }) => (
        <View style={[styles.row, pressed && styles.rowPressed]}>
          <View style={styles.leading}>
            <MobileAgentIcon agentId={card.agent} size={18} />
          </View>
          <View style={styles.main}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {card.title}
              </Text>
              {card.timeAgo ? <Text style={styles.timeAgo}>{card.timeAgo}</Text> : null}
              <View style={expanded ? styles.chevronExpanded : null}>
                <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} />
              </View>
            </View>
            {card.lastMessage ? (
              <Text style={styles.lastMessage} numberOfLines={expanded ? undefined : 2}>
                {card.lastMessage}
              </Text>
            ) : null}
            <View style={styles.metaRow}>
              <Text style={styles.metaText} numberOfLines={1}>
                {`${card.agentLabel} · ${messages}`}
              </Text>
              {showCurrentWorktreeBadge && card.isCurrentWorktree ? (
                <View style={styles.currentBadge}>
                  <Text style={styles.currentBadgeText} numberOfLines={1}>
                    {t('agentHistory.sessionHistoryList.currentWorktree', 'current worktree')}
                  </Text>
                </View>
              ) : null}
            </View>
            <AutoHeight>
              {expanded && session ? <PreviewTurns card={card} session={session} /> : null}
            </AutoHeight>
          </View>
          {session && onResume ? (
            <Pressable
              style={({ pressed: resumePressed }) => [
                styles.resumeButton,
                resumeDisabled && styles.resumeButtonDisabled,
                resumePressed && !resumeDisabled && styles.resumeButtonPressed
              ]}
              onPress={(event) => {
                event.stopPropagation()
                if (!resumeDisabled) {
                  void onResume(session)
                }
              }}
              disabled={resumeDisabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t(
                'agentHistory.sessionHistoryList.resumeSession',
                'Resume agent session'
              )}
            >
              {resumeActionState?.loading ? (
                <ActivityIndicator size="small" color={colors.textPrimary} />
              ) : (
                <Play size={14} color={colors.textPrimary} fill={colors.textPrimary} />
              )}
            </Pressable>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}

// Mounted only while its row is open, so a closed row reads no turns.
function PreviewTurns({
  card,
  session
}: {
  card: MobileAgentHistoryCard
  session: AiVaultSession
}) {
  const t = useMobileTranslation()
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
          <Text style={styles.previewRole}>
            {turn.role === 'user'
              ? t('agentHistory.sessionHistoryList.you', 'You')
              : turn.role === 'assistant'
                ? card.agentLabel
                : turn.role}
          </Text>
          <Text style={styles.previewText}>{turn.text}</Text>
        </View>
      ))}
    </View>
  )
}
