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

// Use NUL-prefixed header keys because message ids cannot contain NUL.
const RESUME_KEY = '\u0000resume'
const CLEAR_KEY = '\u0000clear'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  onClearAll?: (messageIds: string[]) => Promise<boolean>
  // Older hosts cannot edit inline; copy their draft to the composer.
  onEdit?: MobileQueuedMessageEdit
  editor?: MobileQueuedMessageInlineEditor
  pause?: MobileQueuePause
  onResume?: () => Promise<boolean>
  steerHeld?: boolean
}

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
  // Use a ref to block duplicate actions before disabled state renders.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightRef = useRef(new Set<string>())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const largeText = useLargeSystemText()
  if (!cards || cards.length === 0) {
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
  // Forget closed menu identity so a Stop-requeued draft with the same id cannot reopen it.
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
      {}
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
        {largeText && headerActions ? (
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
