import { useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, Pencil, Play, Trash2 } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import { useLargeSystemText } from '../theme/use-large-system-text'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuePause } from './mobile-structured-queued-message-feed'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { MobileQueuedMessageCardRow } from './MobileQueuedMessageCardRow'
import { MobileQueuedMessageScrollList } from './MobileQueuedMessageScrollList'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'

/** The header's in-flight keys beside the cards' message ids, which never contain NUL. */
const RESUME_KEY = '\u0000resume'
const CLEAR_KEY = '\u0000clear'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  /** Steer for a waiting card, the paused queue's included; plain Send for a card held on its own
   *  (its send failed), or a returned one. */
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  onClearAll?: (messageIds: string[]) => Promise<boolean>
  /** Opens an editor in the card; older hosts copy its text to the composer. */
  onEdit?: MobileQueuedMessageEdit
  editor?: MobileQueuedMessageInlineEditor
  /** The whole queue's pause: the header reads Paused, with Clear all and Resume. */
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
  onClearAll,
  onEdit,
  editor,
  pause,
  onResume,
  steerHeld = false
}: MobileNativeChatQueuedMessagesProps): React.JSX.Element | null {
  // One in-flight action per card; a second tap must not double-consume. The ref
  // closes the same-frame double tap the disabled state cannot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightRef = useRef(new Set<string>())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const largeText = useLargeSystemText()
  if (!cards || cards.length === 0) {
    // Collapsing is local to this queue's run: once it empties, the next card shows open.
    if (!expanded) {
      setExpanded(true)
    }
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
  const clearing = busyIds.has(CLEAR_KEY)
  // A card that drained or was removed while its menu was open closes the menu, for good: a
  // Stop-requeued draft comes back under the same id and must not reopen it.
  const menuCard = cards.find((card) => card.messageId === menuFor)
  if (menuFor !== null && !menuCard) {
    setMenuFor(null)
  }
  const headerActions = pause ? (
    <>
      {onClearAll ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: clearing }}
          accessibilityLabel="Delete every queued message"
          style={({ pressed }) => [
            styles.headerAction,
            pressed && styles.pressed,
            clearing && styles.disabled
          ]}
          disabled={clearing}
          onPress={() => void run(CLEAR_KEY, () => onClearAll(cards.map((card) => card.messageId)))}
        >
          <Trash2 size={12} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.actionLabel}>Clear all</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: resuming }}
        accessibilityLabel="Resume sending the queued messages"
        style={({ pressed }) => [
          styles.headerAction,
          pressed && styles.pressed,
          resuming && styles.disabled
        ]}
        disabled={resuming}
        onPress={() => void run(RESUME_KEY, onResume && (() => onResume()))}
      >
        <Play size={12} color={colors.textPrimary} strokeWidth={2} />
        <Text style={styles.actionLabel}>Resume</Text>
      </Pressable>
    </>
  ) : null
  const attentionCaption = !expanded ? cards.find((card) => card.needsAttention)?.caption : null
  const headerCountStyle = [styles.headerCount, attentionCaption && styles.captionReturned]
  return (
    <View style={styles.list}>
      {/* One box: the header is its first row, and the capped list of cards below it. */}
      <View style={styles.box} testID="queued-box">
        {/* A polite region, as the app's other notices: React Native has no status role. */}
        <View
          testID="queued-header"
          style={[styles.header, pause && styles.headerPaused]}
          accessibilityLiveRegion="polite"
        >
          {/* The whole row folds the cards. It sits behind the labels rather than around the
              header's buttons, which VoiceOver could not reach inside another button. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel="Queued messages"
            style={({ pressed }) => [styles.headerToggle, pressed && styles.pressed]}
            onPress={() => setExpanded(!expanded)}
          />
          <View style={styles.headerLabels} pointerEvents="none">
            <Text style={[styles.headerLabel, pause && styles.headerLabelPaused]}>
              {pause ? 'Paused' : 'Queued'}
            </Text>
            <Text
              style={styles.headerLabel}
              importantForAccessibility="no"
              accessibilityElementsHidden
            >
              ·
            </Text>
            <Text style={headerCountStyle}>{cards.length}</Text>
            {attentionCaption ? (
              <Text style={styles.headerCaption} numberOfLines={1}>
                {`· ${attentionCaption}`}
              </Text>
            ) : null}
          </View>
          {largeText ? null : headerActions}
          <View style={styles.chevron} pointerEvents="none">
            {expanded ? (
              <ChevronDown size={12} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <ChevronRight size={12} color={colors.textMuted} strokeWidth={2} />
            )}
          </View>
        </View>
        {/* While a card is edited at large text, the line yields its height to the editor: with
            the keyboard up, a small phone has no room for both. */}
        {largeText && headerActions && !editor ? (
          <View style={[styles.headerActionsLine, styles.headerPaused]}>{headerActions}</View>
        ) : null}
        {expanded ? (
          <MobileQueuedMessageScrollList
            messageIds={cards.map((card) => card.messageId)}
            newestIsPersons={!cards.at(-1)?.attribution}
          >
            {(reveal) =>
              cards.map((card) => {
                const busy = busyIds.has(card.messageId)
                return (
                  <MobileQueuedMessageCardRow
                    key={card.messageId}
                    card={card}
                    editor={editor?.messageId === card.messageId ? editor : undefined}
                    busy={busy}
                    editBlocked={busy || editor !== undefined || !onEdit}
                    steerHeld={steerHeld}
                    onSend={() => void run(card.messageId, onSend)}
                    onDelete={() => void run(card.messageId, onDelete)}
                    onMore={() => setMenuFor(card.messageId)}
                    onEditorLayout={reveal}
                  />
                )
              })
            }
          </MobileQueuedMessageScrollList>
        ) : null}
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
