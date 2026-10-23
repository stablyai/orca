import { useState } from 'react'
import { Pressable, StyleSheet, Text, View, type LayoutRectangle } from 'react-native'
import {
  AlertCircle,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Send,
  Trash2
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { IconButton } from '../components/ui/IconButton'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { MobileNativeChatQueuedMessageEditor } from './MobileNativeChatQueuedMessageEditor'
import { MobileQueuedCardText } from './MobileQueuedCardText'
import {
  QUEUED_ICON_SIZE,
  queuedMessageStyles as styles
} from './mobile-native-chat-queued-message-styles'

type QueuedMessageCardRowProps = {
  card: MobileQueuedMessageCard
  /** Set only on the card being edited. */
  editor?: MobileQueuedMessageInlineEditor
  busy: boolean
  editBlocked: boolean
  steerHeld: boolean
  onSend: () => void
  onDelete: () => void
  onMore: () => void
  /** The edited row's place in the list, so the list can keep it in view. */
  onEditorLayout: (row: LayoutRectangle) => void
}

/** One queued card: its text and actions, or, while it is edited, the editor in their place. */
export function MobileQueuedMessageCardRow({
  card,
  editor,
  onEditorLayout,
  ...actions
}: QueuedMessageCardRowProps): React.JSX.Element {
  if (editor) {
    // The editor replaces the icon, the text, the actions and the caption.
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
  const returnedCaption = returned ? card.caption : undefined
  // "Steer" submits beside the running turn, the paused queue's cards too; a card whose own send
  // failed, or a returned one, is sent again.
  const steers = !returned && !card.paused && !card.command
  return (
    <View testID="queued-card-row" style={[styles.card, styles.divided]}>
      <View style={styles.row}>
        {card.needsAttention ? (
          <AlertCircle size={QUEUED_ICON_SIZE} color={colors.danger} strokeWidth={2.2} />
        ) : (
          <ListEnd size={QUEUED_ICON_SIZE} color={colors.textMuted} strokeWidth={2.2} />
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
          {/* A command never steers: its Send shows only while the agent is idle. */}
          {card.waitsForAgent ? null : (
            <Button
              label={steers ? 'Steer' : 'Send'}
              icon={steers ? CornerDownRight : Send}
              size="compact"
              accessibilityLabel={
                returned
                  ? 'Send this message again'
                  : steers
                    ? 'Submit without interrupting the model'
                    : 'Send this message'
              }
              disabled={busy || steerHeld}
              onPress={onSend}
            />
          )}
          <IconButton
            icon={Trash2}
            variant="bare"
            iconSize={17}
            iconColor={colors.textSecondary}
            accessibilityLabel="Delete this queued message"
            disabled={busy}
            onPress={onDelete}
          />
          {/* The menu holds only Edit, which a command does not take. */}
          {card.command ? null : (
            <IconButton
              icon={MoreHorizontal}
              variant="bare"
              iconSize={17}
              iconColor={colors.textSecondary}
              accessibilityLabel="More actions"
              disabled={editBlocked}
              onPress={onMore}
            />
          )}
        </View>
      </View>
      <Collapsible open={expanded}>
        <View style={[styles.expandedBody, returnedCaption ? localStyles.flushBottom : null]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: true }}
            accessibilityHint="Shows less of the message"
            onPress={() => setExpanded(false)}
          >
            <Text style={styles.bodyText}>{card.text}</Text>
          </Pressable>
        </View>
      </Collapsible>
      {returnedCaption ? (
        <View style={styles.expandedBody}>
          <Text style={[styles.caption, styles.captionReturned]}>{returnedCaption}</Text>
        </View>
      ) : null}
    </View>
  )
}

const localStyles = StyleSheet.create({
  // The returned caption below carries the box's bottom padding.
  flushBottom: { paddingBottom: 0 }
})
