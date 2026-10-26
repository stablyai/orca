import { useState } from 'react'
import { Pressable, Text, View, type LayoutRectangle } from 'react-native'
import {
  AlertCircle,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Send,
  Trash2
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { MobileNativeChatQueuedMessageEditor } from './MobileNativeChatQueuedMessageEditor'
import { MobileQueuedCardText } from './MobileQueuedCardText'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'

type QueuedMessageCardRowProps = {
  card: MobileQueuedMessageCard
  editor?: MobileQueuedMessageInlineEditor
  busy: boolean
  editBlocked: boolean
  steerHeld: boolean
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
  if (editor) {
    return (
      <View
        testID="queued-card-row"
        style={styles.divided}
        onLayout={(event) => onEditorLayout(event.nativeEvent.layout)}
      >
        <MobileNativeChatQueuedMessageEditor editor={editor} attribution={card.attribution} />
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
  onSend,
  onDelete,
  onMore
}: Omit<QueuedMessageCardRowProps, 'editor' | 'onEditorLayout'>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const returned = card.state === 'returned'
  const steers = !returned && !card.paused && !card.command
  return (
    <View testID="queued-card-row" style={[styles.card, styles.divided]}>
      <View style={styles.row}>
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
            text={card.text}
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
          {}
          {card.waitsForAgent ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || steerHeld }}
              accessibilityLabel={
                returned
                  ? 'Send this message again'
                  : steers
                    ? 'Submit without interrupting the model'
                    : 'Send this message'
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
              <Text style={styles.actionLabel}>{steers ? 'Steer' : 'Send'}</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel="Delete this queued message"
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
          {}
          {card.command ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: editBlocked }}
              accessibilityLabel="More actions"
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
              accessibilityHint="Shows less of the message"
              onPress={() => setExpanded(false)}
            >
              <Text style={styles.bodyText}>{card.text}</Text>
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
