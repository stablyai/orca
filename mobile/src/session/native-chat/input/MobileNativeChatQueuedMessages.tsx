import { MobileNativeChatQueueFrame } from './MobileNativeChatQueueFrame'
import { DragReorderList } from '../../../components/DragReorderList'
import type { DragReorderMove } from '../../../components/drag-reorder-positions'
import { useContext, useLayoutEffect, useState, type ReactNode } from 'react'
import { Pressable, Text, View, type LayoutRectangle } from 'react-native'
import { ChevronDown, ChevronUp, Pencil, Play, Trash2 } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useLargeSystemText } from '../../../theme/use-large-system-text'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedHeadLight } from './mobile-queued-head-light'
import {
  createMobileQueuedCardActionStore,
  useMobileQueuedCardActions,
  type MobileQueuedCardActions
} from './mobile-queued-card-actions'
import { headSteerableQueuedMessageCard } from '../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentSessionQueuePause } from '../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'
import type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'
import { MobileQueuedMessageCardRow } from './MobileQueuedMessageCardRow'
import { MobileQueuedMessageScrollList } from './MobileQueuedMessageScrollList'
import { useQueuedRowShow } from './mobile-queued-row-frame'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'
import {
  MobileNativeChatQueueAbovePromptContext,
  useMobileNativeChatLowerRegion
} from '../mobile-native-chat-lower-region-context'

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
  // Folded by default above a prompt card, open above the composer; a choice holds until that changes.
  const abovePrompt = useContext(MobileNativeChatQueueAbovePromptContext)
  const [openChoice, setOpenChoice] = useState<{ open: boolean; abovePrompt: boolean } | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const liveIds = cards?.map((card) => card.messageId) ?? []
  const attentionIds =
    cards?.filter((card) => card.needsAttention).map((card) => card.messageId) ?? []
  const liveKey = `${liveIds.join('\u0000')}\u0001${attentionIds.join('\u0000')}`
  const [seen, setSeen] = useState({ key: liveKey, ids: liveIds, attentionIds })
  const largeText = useLargeSystemText()
  // The card a failure opened the list for, scrolled into view once its row lays out.
  const [showRowId, setShowRowId] = useState(
    () => cards?.slice(1).find((card) => card.needsAttention)?.messageId ?? null
  )
  const measureRow = useQueuedRowShow(showRowId, setShowRowId, liveIds)
  // A choice made in one placement never comes back in a later one (a new prompt folds again);
  // checked first, so a choice this render makes below wins.
  if (openChoice !== null && openChoice.abovePrompt !== abovePrompt) {
    setOpenChoice(null)
  }
  if (liveKey !== seen.key) {
    setSeen({ key: liveKey, ids: liveIds, attentionIds })
    const newest = cards?.at(-1)
    // A message the person just queued opens the list, so it never lands folded out of sight;
    // a delete or reorder that leaves an older card last does not, nor a whole new queue (a switch).
    if (
      newest &&
      !newest.from &&
      !seen.ids.includes(newest.messageId) &&
      seen.ids.some((messageId) => liveIds.includes(messageId))
    ) {
      setOpenChoice({ open: true, abovePrompt })
      setShowRowId(newest.messageId)
    }
    // A card that newly needs attention (failed or returned) behind the fold opens the list,
    // so its own Send is in reach.
    const failedBehindFold = attentionIds.find(
      (messageId) => messageId !== liveIds[0] && !seen.attentionIds.includes(messageId)
    )
    if (failedBehindFold !== undefined) {
      setOpenChoice({ open: true, abovePrompt })
      setShowRowId(failedBehindFold)
    }
    // Forget expanded ids of cards that left the queue.
    if ([...expandedIds].some((messageId) => !liveIds.includes(messageId))) {
      setExpandedIds(new Set([...expandedIds].filter((messageId) => liveIds.includes(messageId))))
    }
  }
  if (!cards || cards.length === 0) {
    if (openChoice !== null) {
      setOpenChoice(null)
    }
    return null
  }
  const toggleExpanded = (messageId: string) =>
    setExpandedIds((current) => {
      const next = new Set(current)
      if (!next.delete(messageId)) {
        next.add(messageId)
      }
      return next
    })
  // Folded by default only while nothing behind the fold needs attention.
  const attentionHidden = cards.slice(1).some((card) => card.needsAttention)
  const open =
    openChoice?.abovePrompt === abovePrompt ? openChoice.open : !abovePrompt || attentionHidden
  // An inline editor on a folded-away card keeps the list open so the edit stays in view.
  const editingHidden = editor !== undefined && editor.messageId !== cards[0]!.messageId
  const showAll = open || cards.length === 1 || editingHidden
  const shownCards = showAll ? cards : cards.slice(0, 1)
  const queueBusy = busyIds.has(QUEUE_KEY)
  const headId = headSteerableQueuedMessageCard(cards)?.messageId
  const messageIds = cards.map((card) => card.messageId)
  // Clear all takes every card, so it waits for any card's own action rather than skip that card.
  const clearBusy = queueBusy || messageIds.some((messageId) => busyIds.has(messageId))
  const clearAll = () => {
    if (onClearAll) {
      void run(QUEUE_KEY, () => onClearAll(messageIds), messageIds)
    }
  }
  // Forget closed menu identity so a Stop-requeued draft with the same id cannot reopen it.
  const menuCard = cards.find((card) => card.messageId === menuFor)
  if (menuFor !== null && !menuCard) {
    setMenuFor(null)
  }
  // A paused queue keeps a header for Resume and Clear all; an unpaused one offers Clear all in each menu.
  const headerActions = pause ? (
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
          onPress={clearAll}
        >
          <Trash2 size={12} color={colors.textPrimary} strokeWidth={2} />
          <Text style={styles.actionLabel}>{t('chat.queuedMessages.clearAll', 'Clear all')}</Text>
        </Pressable>
      ) : null}
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
    </>
  ) : null
  const hiddenCount = cards.length - 1
  const foldLabel = showAll
    ? t('chat.queuedMessages.showLess', 'Show less')
    : hiddenCount === 1
      ? t('chat.queuedMessages.moreCount_one', '{{count}} more', { count: hiddenCount })
      : t('chat.queuedMessages.moreCount_other', '{{count}} more', { count: hiddenCount })
  const renderRow = (
    card: MobileQueuedMessageCard,
    reveal: (row: LayoutRectangle) => void,
    show: (row: LayoutRectangle) => void,
    handle?: ReactNode
  ) => {
    const first = card.messageId === cards[0]!.messageId
    return (
      <MobileQueuedMessageCardRow
        key={card.messageId}
        card={card}
        dragHandle={handle}
        editor={editor?.messageId === card.messageId ? editor : undefined}
        busy={busyIds.has(card.messageId)}
        headLight={card.messageId === headId ? headLight : undefined}
        steerHeld={steerHeld}
        agentWorking={agentWorking}
        // A returned or failed head reads its own caption, not "Queued".
        lead={
          first && !pause && card.state !== 'returned' && !card.needsAttention
            ? t('chat.queuedMessages.queuedState', 'Queued')
            : undefined
        }
        leadLabel={
          cards.length === 1
            ? t('chat.queuedMessages.queuedCount_one', '{{count}} queued message', {
                count: cards.length
              })
            : t('chat.queuedMessages.queuedCount_other', '{{count}} queued messages', {
                count: cards.length
              })
        }
        divided={!first || pause != null}
        expanded={expandedIds.has(card.messageId)}
        onToggleExpanded={() => toggleExpanded(card.messageId)}
        onSend={() => void run(card.messageId, onSend)}
        onMore={() => setMenuFor(card.messageId)}
        onEditorLayout={reveal}
        onRowHeight={(height) => measureRow({ messageIds, showAll }, card.messageId, height, show)}
      />
    )
  }
  const menuEditable =
    menuCard !== undefined &&
    !menuCard.command &&
    onEdit !== undefined &&
    editor === undefined &&
    !busyIds.has(menuCard.messageId)
  return (
    <MobileNativeChatQueueFrame editing={editor !== undefined}>
      <MobileNativeChatQueueFrame box editing={editor !== undefined}>
        {pause ? (
          <>
            {/* A polite region, as the app's other notices: React Native has no status role. */}
            <View
              testID="queued-header"
              style={[styles.header, styles.headerPaused]}
              accessibilityLiveRegion="polite"
            >
              <View style={styles.headerLabels}>
                <Text style={[styles.headerLabel, styles.headerLabelPaused]}>
                  {t('chat.queuedMessages.pausedState', 'Paused')}
                </Text>
                <Text
                  style={styles.headerLabel}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                >
                  ·
                </Text>
                <Text style={styles.headerCount}>{cards.length}</Text>
              </View>
              {largeText ? null : headerActions}
            </View>
            {largeText ? (
              <View style={[styles.headerActionsLine, styles.headerPaused]}>{headerActions}</View>
            ) : null}
          </>
        ) : null}
        <MobileQueuedMessageScrollList
          messageIds={messageIds}
          newestIsPersons={!cards.at(-1)?.from}
          inlineEditorActive={editor !== undefined}
        >
          {(reveal, drag, show) => {
            // Order matters only with two or more cards in view, so the grip shows only then.
            return onMove && !editor && showAll && cards.length > 1 ? (
              <DragReorderList
                items={cards}
                itemKey={(card) => card.messageId}
                isMoveDisabled={(card) => busyIds.has(MOVE_KEY) || busyIds.has(card.messageId)}
                rowPresentation="plain"
                liftFromRow
                renderRow={(card, handle) => renderRow(card, reveal, show, handle)}
                onMove={(move) => run(move.movedId, () => onMove(move), [MOVE_KEY])}
                {...drag}
              />
            ) : (
              shownCards.map((card) => renderRow(card, reveal, show))
            )
          }}
        </MobileQueuedMessageScrollList>
        {cards.length > 1 && !editingHidden ? (
          <Pressable
            testID="queued-fold-toggle"
            accessibilityRole="button"
            accessibilityState={{ expanded: showAll }}
            style={({ pressed }) => [styles.foldToggle, pressed && styles.pressed]}
            onPress={() => {
              setShowRowId(null)
              setOpenChoice({ open: !showAll, abovePrompt })
            }}
          >
            <Text
              style={styles.foldLabel}
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              accessibilityLabel={
                !showAll && attentionHidden
                  ? t(
                      'chat.queuedMessages.foldNeedsAttention',
                      '{{more}}, a message needs attention',
                      {
                        more: foldLabel
                      }
                    )
                  : undefined
              }
            >
              {foldLabel}
            </Text>
            {showAll ? (
              <ChevronUp size={12} color={colors.textSecondary} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} color={colors.textSecondary} strokeWidth={2} />
            )}
          </Pressable>
        ) : null}
      </MobileNativeChatQueueFrame>
      <ActionSheetModal
        visible={menuCard !== undefined}
        title={menuCard?.line}
        actions={[
          ...(menuCard?.command
            ? []
            : [
                {
                  id: 'editMessage',
                  label: t('chat.queuedMessages.editMessage', 'Edit message'),
                  icon: Pencil,
                  disabled: !menuEditable,
                  // Runs once the sheet's Modal is gone, so the composer Edit fills can take focus.
                  closeBeforePress: true,
                  onPress: () => {
                    if (menuCard) {
                      void run(menuCard.messageId, onEdit)
                    }
                  }
                }
              ]),
          {
            id: 'deleteMessage',
            label: t('chat.queuedMessages.deleteMessage', 'Delete message'),
            icon: Trash2,
            destructive: true,
            disabled: menuCard === undefined || busyIds.has(menuCard.messageId),
            onPress: () => {
              if (menuCard) {
                void run(menuCard.messageId, onDelete)
              }
            }
          },
          ...(clearable && !pause && onClearAll && cards.length > 1
            ? [
                {
                  id: 'clearAll',
                  label: t('chat.queuedMessages.deleteAll', 'Delete every queued message'),
                  icon: Trash2,
                  destructive: true,
                  disabled: clearBusy,
                  onPress: clearAll
                }
              ]
            : [])
        ]}
        onClose={() => setMenuFor(null)}
      />
    </MobileNativeChatQueueFrame>
  )
}
