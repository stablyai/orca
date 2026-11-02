import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { MoreHorizontal, Pin } from 'lucide-react-native'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { ConversationRow } from './conversation-project'
import { conversationCopy, conversationTimeAgo } from './conversation-copy'
import { conversationStyles as styles } from './conversation-styles'

export function ConversationListRow({
  item,
  connected,
  busy,
  pinned,
  now,
  onOpen,
  onDetails
}: {
  item: ConversationRow
  connected: boolean
  busy: string | null
  pinned: boolean
  now: number
  onOpen: (row: ConversationRow) => void
  onDetails: (row: ConversationRow) => void
}) {
  useMobileColorScheme()
  const copy = conversationCopy()
  const offline = !connected || Boolean(item.workspace?.hostContextHealthLabel)
  return (
    <View style={styles.row} testID="conversation-row">
      <Pressable
        onPress={() => onOpen(item)}
        onLongPress={() => onDetails(item)}
        disabled={offline || busy !== null}
        style={({ pressed }) => [styles.rowButton, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={[item.title, item.preview].filter(Boolean).join('. ')}
      >
        <MobileAgentIcon agentId={item.agent ?? ''} size={20} />
        <View style={styles.rowText}>
          <View style={styles.rowMeta}>
            {pinned ? <Pin size={12} color={colors.textSecondary} /> : null}
            <Text style={[styles.rowTitle, styles.sectionName]} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
          {item.preview ? (
            <Text style={styles.rowPreview} numberOfLines={2} testID="conversation-preview">
              {item.preview}
            </Text>
          ) : null}
          <View style={styles.rowMeta}>
            <AgentStateDot
              state={
                offline
                  ? 'unverifiable'
                  : item.status === 'saved' || item.status === 'transcript'
                    ? 'idle'
                    : item.status
              }
            />
            <Text style={styles.meta} numberOfLines={1}>
              {[
                item.agent ? formatAgentTypeLabel(item.agent) : null,
                offline
                  ? copy.offline
                  : item.status === 'saved'
                    ? copy.saved
                    : item.status === 'transcript'
                      ? copy.transcript
                      : item.status === 'failed'
                        ? copy.failedState
                        : item.status === 'unverifiable'
                          ? copy.unconfirmed
                          : copy[item.status],
                item.at ? conversationTimeAgo(item.at, now) : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
        {busy === item.key ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      </Pressable>
      <Pressable
        onPress={() => onDetails(item)}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={`${copy.details}: ${item.title}`}
      >
        <MoreHorizontal size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}
