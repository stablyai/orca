import { MobileNativeChatQueueFrame } from './MobileNativeChatQueueFrame'
import { DragReorderList } from '../../../components/DragReorderList'
import type { DragReorderMove } from '../../../components/drag-reorder-positions'
import { useLayoutEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, Pencil, Play, Trash2 } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useLargeSystemText } from '../../../theme/use-large-system-text'
import type { MobileQueuedMessageCard } from '../../mobile-structured-queued-message-cards'
import type { MobileQueuedHeadLight } from './mobile-queued-head-light'
import {
  createMobileQueuedCardActionStore,
  useMobileQueuedCardActions,
  type MobileQueuedCardActions
} from './mobile-queued-card-actions'
import { headSteerableQueuedMessageCard } from '../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentSessionQueuePause } from '../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { MobileQueuedMessageEdit } from '../../use-mobile-structured-queued-message-controls'
import type { MobileQueuedMessageInlineEditor } from '../../mobile-queued-message-edit-draft'
import { MobileQueuedMessageCardRow } from '../../MobileQueuedMessageCardRow'
import { MobileQueuedMessageScrollList } from '../../MobileQueuedMessageScrollList'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'
import { useMobileNativeChatLowerRegion } from '../mobile-native-chat-lower-region-context'

// Use NUL-prefixed header keys because message ids cannot contain NUL.
// Resume and Clear all share one key: a Resume would send the cards a Clear is deleting.
const QUEUE_KEY = '\u0000queue'
const MOVE_KEY = '\u0000move'

/** The card an empty Cmd/Ctrl+Enter presses, or null where it presses none. */
export function mobileNativeChatChordHeadId(
  {
    cards,
    steerHeld,
    agentWorking,
    editor
  }: Pick<MobileNativeChatQueuedMessagesProps, 'cards' | 'steerHeld' | 'agentWorking' | 'editor'>,
  alternateSteers: boolean
): string | null {
  // Mid-turn only where the chord's other way is steer, or a second press would steer the card
  // the first one just queued; with no turn running the card's own Send (a paused queue after Stop).
  const steers = !steerHeld && (alternateSteers || !agentWorking)
  const head = cards && steers ? headSteerableQueuedMessageCard(cards) : null
  return head && editor?.messageId !== head.messageId ? head.messageId : null
}

export type MobileNativeChatQueuedMessagesProps = {
  /** The chat's card actions, owned above the list; a list mounted alone keeps its own. */
  actions?: MobileQueuedCardActions
  cards?: MobileQueuedMessageCard[]
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  onClearAll?: (messageIds: string[]) => Promise<boolean>
  /** Offers Clear all while the queue still sends on its own; otherwise only a paused queue does. */
  clearable?: boolean
  // Older hosts cannot edit inline; copy their draft to the composer.
  onEdit?: MobileQueuedMessageEdit
  editor?: MobileQueuedMessageInlineEditor
  onMove?: (move: DragReorderMove) => Promise<boolean>
  pause?: AgentSessionQueuePause | null
  onResume?: () => Promise<boolean>
  steerHeld?: boolean
  /** Lights the head card while the composer previews sending it (Steer queued). */
  headLight?: MobileQueuedHeadLight
  /** The agent is working: a steerable card's action reads Steer, otherwise Send. */
  agentWorking?: boolean
}

export function MobileNativeChatQueuedMessages({
  actions,
  cards,
  onSend,
  onDelete,
  onClearAll,
  clearable = false,
  onEdit,
  editor,
  onMove,
  pause,
  onResume,
  steerHeld = false,
  headLight,
  agentWorking = false
}: MobileNativeChatQueuedMessagesProps): React.JSX.Element | null {
  useMobileColorScheme()
  const lowerRegion = useMobileNativeChatLowerRegion()
  useLayoutEffect(() => lowerRegion?.layoutChanged())
  const t = useMobileTranslation()
  const [ownStore] = useState(createMobileQueuedCardActionStore)
  const ownActions = useMobileQueuedCardActions(ownStore, '')
  const { busyIds, run } = actions ?? ownActions
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const largeText = useLargeSystemText()
  if (!cards || cards.length === 0) {
    if (!expanded) {
      setExpanded(true)
    }
    return null
  }
  const queueBusy = busyIds.has(QUEUE_KEY)
  const headId = headSteerableQueuedMessageCard(cards)?.messageId
  const messageIds = cards.map((card) => card.messageId)
  // Clear all takes every card, so it waits for any card's own action rather than skip that card.
  const clearBusy = queueBusy || messageIds.some((messageId) => busyIds.has(messageId))
  // Forget closed menu identity so a Stop-requeued draft with the same id cannot reopen it.
  const menuCard = cards.find((card) => card.messageId === menuFor)
  if (menuFor !== null && !menuCard) {
    setMenuFor(null)
  }
  const actionable = pause || clearable
  const headerActions = actionable ? (
    <>
      {onClearAll ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: clearBusy }}
          accessibilityLabel={t('chat.queuedMessages.deleteAll', 'Delete every queued message')}
          style={({ pressed }) => [
            styles.headerAction,
            pressed && styles.pressed,
            clearBusy && styles.disabled
          ]}
          disabled={clearBusy}
          onPress={() => void run(QUEUE_KEY, () => onClearAll(messageIds), messageIds)}
        >
          <Trash2 size={12} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.actionLabel}>{t('chat.queuedMessages.clearAll', 'Clear all')}</Text>
        </Pressable>
      ) : null}
      {pause ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: queueBusy }}
          accessibilityLabel={t(
            'chat.queuedMessages.resumeSending',
            'Resume sending the queued messages'
          )}
          style={({ pressed }) => [
            styles.headerAction,
            pressed && styles.pressed,
            queueBusy && styles.disabled
          ]}
          disabled={queueBusy}
          onPress={() => void run(QUEUE_KEY, onResume && (() => onResume()))}
        >
          <Play size={12} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.actionLabel}>{t('chat.queuedMessages.resume', 'Resume')}</Text>
        </Pressable>
      ) : null}
    </>
  ) : null
  const attentionCaption = !expanded ? cards.find((card) => card.needsAttention)?.caption : null
  const headerCountStyle = [styles.headerCount, attentionCaption && styles.captionReturned]
  return (
    <MobileNativeChatQueueFrame editing={editor !== undefined}>
      {}
      <MobileNativeChatQueueFrame box editing={editor !== undefined}>
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
            accessibilityLabel={t('chat.queuedMessages.title', 'Queued messages')}
            style={({ pressed }) => [styles.headerToggle, pressed && styles.pressed]}
            onPress={() => setExpanded(!expanded)}
          />
          <View style={styles.headerLabels} pointerEvents="none">
            <Text style={[styles.headerLabel, pause && styles.headerLabelPaused]}>
              {pause
                ? t('chat.queuedMessages.pausedState', 'Paused')
                : t('chat.queuedMessages.queuedState', 'Queued')}
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
            newestIsPersons={!cards.at(-1)?.from}
            inlineEditorActive={editor !== undefined}
          >
            {(reveal, drag) => {
              const renderRow = (card: MobileQueuedMessageCard, handle?: React.ReactNode) => (
                <MobileQueuedMessageCardRow
                  key={card.messageId}
                  card={card}
                  dragHandle={handle}
                  editor={editor?.messageId === card.messageId ? editor : undefined}
                  busy={busyIds.has(card.messageId)}
                  headLight={card.messageId === headId ? headLight : undefined}
                  editBlocked={busyIds.has(card.messageId) || editor !== undefined || !onEdit}
                  steerHeld={steerHeld}
                  agentWorking={agentWorking}
                  onSend={() => void run(card.messageId, onSend)}
                  onDelete={() => void run(card.messageId, onDelete)}
                  onMore={() => setMenuFor(card.messageId)}
                  onEditorLayout={reveal}
                />
              )
              return onMove && !editor ? (
                <DragReorderList
                  items={cards}
                  itemKey={(card) => card.messageId}
                  isMoveDisabled={(card) => busyIds.has(MOVE_KEY) || busyIds.has(card.messageId)}
                  rowPresentation="plain"
                  renderRow={renderRow}
                  onMove={(move) => run(move.movedId, () => onMove(move), [MOVE_KEY])}
                  {...drag}
                />
              ) : (
                cards.map((card) => renderRow(card))
              )
            }}
          </MobileQueuedMessageScrollList>
        ) : null}
      </MobileNativeChatQueueFrame>
      <ActionSheetModal
        visible={menuCard !== undefined}
        title={menuCard?.line}
        actions={[
          {
            id: 'editMessage',
            label: t('chat.queuedMessages.editMessage', 'Edit message'),
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
    </MobileNativeChatQueueFrame>
  )
}
