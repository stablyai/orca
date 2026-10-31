import type { ReactNode } from 'react'
import { useState } from 'react'
import { Pressable, Text, View, type LayoutRectangle } from 'react-native'
import {
  AlertCircle,
  CornerDownRight,
  ListEnd,
  Image as ImageIcon,
  MoreHorizontal,
  Send,
  Trash2
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { queuedMessageCardSteers } from '../../../src/shared/structured-agent-session-queued-cards'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import { MobileQueuedCardText } from './MobileQueuedCardText'
import { queuedMessageStyles as styles } from './native-chat/input/mobile-native-chat-queued-message-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type QueuedMessageCardRowProps = {
  dragHandle?: ReactNode
  card: MobileQueuedMessageCard
  editor?: MobileQueuedMessageInlineEditor
  busy: boolean
  editBlocked: boolean
  steerHeld: boolean
  /** Steer only into a running turn; an idle agent's card reads Send. */
  agentWorking: boolean
  onSend: () => void
  onDelete: () => void
  onMore: () => void
  onEditorLayout: (row: LayoutRectangle) => void
}

export function MobileQueuedMessageCardRow({
  card,
  editor,
  onEditorLayout,
  ...actions
}: QueuedMessageCardRowProps): React.JSX.Element {
  useMobileColorScheme()
  if (editor) {
    return (
      <View
        testID="queued-card-row"
        style={styles.divided}
        onLayout={(event) => onEditorLayout(event.nativeEvent.layout)}
      >
        <MobileQueuedMessageComposer editor={editor} attribution={card.attribution} />
      </View>
    )
  }
  return <QueuedMessageCardContents card={card} {...actions} />
}

function QueuedMessageCardContents({
  card,
  busy,
  editBlocked,
  steerHeld,
  agentWorking,
  onSend,
  onDelete,
  onMore,
  dragHandle
}: Omit<QueuedMessageCardRowProps, 'editor' | 'onEditorLayout'>): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const returned = card.state === 'returned'
  const steers = agentWorking && queuedMessageCardSteers(card)
  const count = card.images?.length ?? 0
  return (
    <View testID="queued-card-row" style={[styles.card, styles.divided]}>
      <View style={styles.row}>
        {dragHandle}
        {card.needsAttention ? (
          <AlertCircle size={14} color={colors.statusRed} strokeWidth={2} />
        ) : (
          <ListEnd size={14} color={colors.textMuted} strokeWidth={2} />
        )}
        <View style={styles.textColumn}>
          {card.attribution ? (
            <Text style={styles.caption} numberOfLines={1}>
              {card.attribution}
            </Text>
          ) : null}
          <MobileQueuedCardText
            text={card.line}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
          />
          {card.caption && !returned ? (
            <Text style={styles.caption} numberOfLines={1}>
              {card.caption}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          {card.images ? (
            <View
              style={styles.actions}
              accessible
              accessibilityLabel={
                count === 1
                  ? t('session.queuedMessageCardRow.images_one', '{{count}} image', { count })
                  : t('session.queuedMessageCardRow.images_other', '{{count}} images', { count })
              }
            >
              <ImageIcon size={12} color={colors.textMuted} strokeWidth={2} />
              <Text style={styles.caption}>{card.images.length}</Text>
            </View>
          ) : null}
          {card.waitsForAgent ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || steerHeld }}
              accessibilityLabel={
                returned
                  ? t('session.queuedMessageCardRow.sendAgainHint', 'Send this message again')
                  : steers
                    ? t(
                        'session.queuedMessageCardRow.steerHint',
                        'Submit without interrupting the model'
                      )
                    : t('session.queuedMessageCardRow.sendHint', 'Send this message')
              }
              style={({ pressed }) => [
                styles.textAction,
                pressed && styles.pressed,
                (busy || steerHeld) && styles.disabled
              ]}
              disabled={busy || steerHeld}
              onPress={onSend}
            >
              {steers ? (
                <CornerDownRight size={12} color={colors.textPrimary} strokeWidth={2} />
              ) : (
                <Send size={12} color={colors.textPrimary} strokeWidth={2} />
              )}
              <Text style={styles.actionLabel}>
                {steers
                  ? t('session.queuedMessageCardRow.steer', 'Steer')
                  : t('session.queuedMessageCardRow.send', 'Send')}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel={t(
              'session.queuedMessageCardRow.deleteHint',
              'Delete this queued message'
            )}
            style={({ pressed }) => [
              styles.iconAction,
              card.command && styles.lastIconAction,
              pressed && styles.pressed,
              busy && styles.disabled
            ]}
            disabled={busy}
            onPress={onDelete}
          >
            <Trash2 size={14} color={colors.textPrimary} strokeWidth={2} />
          </Pressable>
          {card.command ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: editBlocked }}
              accessibilityLabel={t('session.queuedMessageCardRow.moreActions', 'More actions')}
              style={({ pressed }) => [
                styles.iconAction,
                styles.lastIconAction,
                pressed && styles.pressed,
                editBlocked && styles.disabled
              ]}
              disabled={editBlocked}
              onPress={onMore}
            >
              <MoreHorizontal size={14} color={colors.textPrimary} strokeWidth={2} />
            </Pressable>
          )}
        </View>
      </View>
      {expanded || (returned && card.caption) ? (
        <View style={styles.expandedBody}>
          {expanded ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: true }}
              accessibilityHint={t(
                'session.queuedMessageCardRow.showLessHint',
                'Shows less of the message'
              )}
              onPress={() => setExpanded(false)}
            >
              <Text style={styles.bodyText}>{card.line}</Text>
            </Pressable>
          ) : null}
          {returned && card.caption ? (
            <Text style={[styles.caption, styles.captionReturned]}>{card.caption}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
