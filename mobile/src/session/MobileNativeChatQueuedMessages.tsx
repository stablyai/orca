import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  AlertCircle,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2
} from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  mobileQueuePauseLabel,
  type MobileQueuedMessageCard
} from './mobile-structured-queued-message-cards'
import type { MobileQueuePause } from './mobile-structured-queued-message-feed'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'

/** The Resume row's in-flight key beside the cards' message ids, which never contain NUL. */
const RESUME_KEY = '\u0000resume'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  /** Steer for a waiting card, the paused queue's included; plain Send for a card held on its own
   *  (its send failed, or the host kept it unsent), or a returned one. */
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  /** Copy the card's text into the composer, then delete the card. */
  onEdit?: MobileQueuedMessageEdit
  /** The whole queue's pause: the box's first row, with Resume. */
  pause?: MobileQueuePause
  onResume?: () => Promise<boolean>
  /** The chat reads Stopping: no card steers into the turn a Stop is ending. */
  steerHeld?: boolean
}

/** The host-held queued drafts, as one box of compact rows between transcript and
 *  composer — a queued message is never an optimistic transcript bubble. */
export function MobileNativeChatQueuedMessages({
  cards,
  onSend,
  onDelete,
  onEdit,
  pause,
  onResume,
  steerHeld = false
}: MobileNativeChatQueuedMessagesProps): React.JSX.Element | null {
  // One in-flight action per card; a second tap must not double-consume. The ref
  // closes the same-frame double tap the disabled state cannot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightRef = useRef(new Set<string>())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  if (!cards || cards.length === 0) {
    return null
  }
  const run = async (messageId: string, action?: (id: string) => Promise<boolean>) => {
    if (inFlightRef.current.has(messageId) || !action) {
      return
    }
    inFlightRef.current.add(messageId)
    setBusyIds(new Set(inFlightRef.current))
    try {
      await action(messageId)
    } finally {
      inFlightRef.current.delete(messageId)
      setBusyIds(new Set(inFlightRef.current))
    }
  }
  const resuming = busyIds.has(RESUME_KEY)
  // A card that drained or was removed while its menu was open closes the menu, for good: a
  // Stop-requeued draft comes back under the same id and must not reopen it.
  const menuCard = cards.find((card) => card.messageId === menuFor)
  if (menuFor !== null && !menuCard) {
    setMenuFor(null)
  }
  return (
    <View style={styles.list}>
      {/* One box: the pause row, when shown, is its first row, and each card a row below it. */}
      <View style={styles.box}>
        {pause ? (
          // A polite region, as the app's other notices: React Native has no status role.
          <View testID="queued-pause-row" style={styles.row} accessibilityLiveRegion="polite">
            <Pause size={14} color={colors.textMuted} strokeWidth={2} />
            <Text style={styles.pauseLabel} numberOfLines={1}>
              {mobileQueuePauseLabel(pause)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: resuming }}
              accessibilityLabel="Resume sending the queued messages"
              style={({ pressed }) => [
                styles.textAction,
                pressed && styles.pressed,
                resuming && styles.disabled
              ]}
              disabled={resuming}
              onPress={() => void run(RESUME_KEY, onResume && (() => onResume()))}
            >
              <Play size={12} color={colors.textPrimary} strokeWidth={2} />
              <Text style={styles.actionLabel}>Resume</Text>
            </Pressable>
          </View>
        ) : null}
        {cards.map((card, index) => {
          const busy = busyIds.has(card.messageId)
          const returned = card.state === 'returned'
          // "Steer" submits beside the running turn, the paused queue's cards too; a card whose
          // own send failed, or a returned one, is sent again.
          const steers = !returned && !card.paused
          return (
            <View
              key={card.messageId}
              testID="queued-card-row"
              style={[styles.row, (pause || index > 0) && styles.divided]}
            >
              {card.needsAttention ? (
                <AlertCircle size={14} color={colors.statusRed} strokeWidth={2} />
              ) : (
                <ListEnd size={14} color={colors.textMuted} strokeWidth={2} />
              )}
              <View style={styles.textColumn}>
                {/* Two lines, not the desktop's one: the phone row has no hover title to read the rest. */}
                <Text style={styles.body} numberOfLines={2}>
                  {card.text}
                </Text>
                {card.caption ? (
                  // A returned card's reason only reads whole, often at its end; a hold is one line.
                  <Text
                    style={[styles.caption, returned && styles.captionReturned]}
                    numberOfLines={returned ? undefined : 1}
                  >
                    {card.caption}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || steerHeld }}
                accessibilityLabel={
                  returned
                    ? 'Send this message again'
                    : card.paused
                      ? 'Send this message'
                      : 'Submit without interrupting the model'
                }
                style={({ pressed }) => [
                  styles.textAction,
                  pressed && styles.pressed,
                  (busy || steerHeld) && styles.disabled
                ]}
                disabled={busy || steerHeld}
                onPress={() => void run(card.messageId, onSend)}
              >
                {steers ? (
                  <CornerDownRight size={12} color={colors.textPrimary} strokeWidth={2} />
                ) : (
                  <Send size={12} color={colors.textPrimary} strokeWidth={2} />
                )}
                <Text style={styles.actionLabel}>{steers ? 'Steer' : 'Send'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel="Delete this queued message"
                style={({ pressed }) => [
                  styles.iconAction,
                  pressed && styles.pressed,
                  busy && styles.disabled
                ]}
                disabled={busy}
                onPress={() => void run(card.messageId, onDelete)}
              >
                <Trash2 size={14} color={colors.textPrimary} strokeWidth={2} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel="More actions"
                style={({ pressed }) => [
                  styles.iconAction,
                  pressed && styles.pressed,
                  busy && styles.disabled
                ]}
                disabled={busy}
                onPress={() => setMenuFor(card.messageId)}
              >
                <MoreHorizontal size={14} color={colors.textPrimary} strokeWidth={2} />
              </Pressable>
            </View>
          )
        })}
      </View>
      <ActionSheetModal
        visible={menuCard !== undefined}
        title={menuCard?.text}
        actions={[
          {
            label: 'Edit message',
            icon: Pencil,
            // Runs once the sheet's Modal is gone, so the composer Edit fills can take focus.
            closeBeforePress: true,
            onPress: () => {
              if (menuCard) {
                void run(menuCard.messageId, onEdit)
              }
            }
          }
        ]}
        onClose={() => setMenuFor(null)}
      />
    </View>
  )
}

// Every action touches as a 44pt target (platform floor) inside its row: Android drops touches
// outside the parent, so the row is at least that tall and nothing overhangs it.
const MIN_TOUCH_TARGET = 44

const styles = StyleSheet.create({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  row: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  pauseLabel: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    gap: 2
  },
  body: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  captionReturned: {
    color: colors.statusRed
  },
  textAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  iconAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.5
  }
})
