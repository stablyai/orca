import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native'
import {
  AlertCircle,
  CornerDownRight,
  Image as ImageIcon,
  MoreHorizontal,
  Send
} from '../../../../components/icons/app-icons'
import { colors } from '../../../../theme/mobile-theme'
import { queuedMessageCardSteers } from '../../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuedMessageInlineEditor } from './mobile-queued-message-edit-draft'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import { MobileQueuedCardText } from './MobileQueuedCardText'
import type { MobileQueuedHeadLight } from './mobile-queued-head-light'
import { MobileAgentMessageSenders } from '../../transcript/agent-messages/MobileAgentMessageSenders'
import { MobileQueuedTypedByLine } from '../../transcript/messages/MobileNativeChatUserMessageMarks'
import {
  QUEUED_ROW_NARROW_WIDTH,
  queuedMessageStyles as styles
} from './mobile-native-chat-queued-message-styles'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'
import type { MobileQueuedCardControl } from './mobile-queued-card-actions'

const subscribeNever = () => () => undefined
// The 32pt pill reaches 44pt inside the row's own height; Android drops touches outside the parent.
const STEER_HIT_SLOP = { top: 6, bottom: 6 }

type QueuedMessageCardRowProps = {
  dragHandle?: ReactNode
  card: MobileQueuedMessageCard
  editor?: MobileQueuedMessageInlineEditor
  /** The control whose action for this card is on its way, if any. */
  busyControl?: MobileQueuedCardControl
  /** Set on the card the composer's Steer queued preview would send. */
  headLight?: MobileQueuedHeadLight
  steerHeld: boolean
  /** Steer only into a running turn; an idle agent's card reads Send. */
  agentWorking: boolean
  /** Leads the first row's meta line ("Queued ·"); later rows show only the sender. */
  lead?: string
  /** Spoken for the lead, and announced as the count changes: the queue has no header of its own. */
  leadLabel?: string
  /** Draws the hairline above the row: every row but the box's first. */
  divided: boolean
  /** The whole message is open; held by the list so folding, which remounts rows, keeps it. */
  expanded: boolean
  onToggleExpanded: () => void
  onSend: () => void
  onMore: () => void
  onEditorLayout: (row: LayoutRectangle) => void
  /** The compact row's height, so the list can scroll to a row that needs attention. */
  onRowHeight?: (height: number) => void
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
        style={actions.divided && styles.divided}
        onLayout={(event) => {
          onEditorLayout(event.nativeEvent.layout)
          // An open editor still stacks above later rows, so the list places them past it.
          actions.onRowHeight?.(event.nativeEvent.layout.height)
        }}
      >
        <MobileQueuedMessageComposer editor={editor} from={card.from} />
      </View>
    )
  }
  return <QueuedMessageCardContents card={card} {...actions} />
}

function QueuedMessageCardContents({
  card,
  busyControl,
  headLight,
  steerHeld,
  agentWorking,
  lead,
  leadLabel,
  divided,
  expanded,
  onToggleExpanded,
  onSend,
  onMore,
  onRowHeight,
  dragHandle
}: Omit<QueuedMessageCardRowProps, 'editor' | 'onEditorLayout'>): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const narrow = useWindowDimensions().width < QUEUED_ROW_NARROW_WIDTH
  const returned = card.state === 'returned'
  // A card that needs attention offers its retry, Send, which is what its caption names.
  const busy = busyControl !== undefined
  const steers = agentWorking && !card.needsAttention && queuedMessageCardSteers(card)
  const count = card.images?.length ?? 0
  const lit = useSyncExternalStore(
    headLight?.subscribe ?? subscribeNever,
    () => headLight?.get() === true
  )
  return (
    <View
      testID="queued-card-row"
      style={[styles.card, divided && styles.divided, lit && styles.lit]}
      onLayout={onRowHeight && ((event) => onRowHeight(event.nativeEvent.layout.height))}
    >
      <View style={[styles.row, dragHandle ? styles.rowWithHandle : null]}>
        {dragHandle}
        <View style={styles.textColumn}>
          <View style={styles.metaLine}>
            {card.needsAttention ? (
              <AlertCircle size={12} color={colors.statusRed} strokeWidth={2} />
            ) : null}
            {lead ? (
              <>
                <Text
                  style={styles.metaLead}
                  numberOfLines={1}
                  accessibilityLabel={leadLabel}
                  accessibilityLiveRegion="polite"
                >
                  {lead}
                </Text>
                <Text
                  style={[styles.metaText, styles.metaFixed]}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                >
                  ·
                </Text>
              </>
            ) : null}
            {card.from ? (
              <View style={styles.metaSenders}>
                <MobileAgentMessageSenders queued bare from={card.from} />
              </View>
            ) : card.typedByOther ? (
              <MobileQueuedTypedByLine typist={card.typedByOther} textStyle={styles.metaText} />
            ) : (
              <Text style={styles.metaText} numberOfLines={1}>
                {t('session.queuedMessageCardRow.you', 'You')}
              </Text>
            )}
            {card.images ? (
              <View
                style={[styles.metaLine, styles.metaFixed]}
                accessible
                accessibilityLabel={
                  count === 1
                    ? t('session.queuedMessageCardRow.images_one', '{{count}} image', { count })
                    : t('session.queuedMessageCardRow.images_other', '{{count}} images', { count })
                }
              >
                <ImageIcon size={12} color={colors.textSecondary} strokeWidth={2} />
                <Text style={styles.metaText}>{count}</Text>
              </View>
            ) : null}
          </View>
          <MobileQueuedCardText
            text={card.line}
            lines={narrow ? 2 : 1}
            expanded={expanded}
            onToggle={onToggleExpanded}
          />
          {card.caption && !returned ? (
            <Text style={styles.caption} numberOfLines={2}>
              {card.caption}
            </Text>
          ) : null}
        </View>
        {card.waitsForAgent ? null : (
          <MobilePendingButton
            label={
              steers
                ? t('session.queuedMessageCardRow.steer', 'Steer')
                : t('session.queuedMessageCardRow.send', 'Send')
            }
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
            hitSlop={STEER_HIT_SLOP}
            // Filled like the composer's primary while Steer queued would press it.
            style={[styles.steerPill, lit && styles.litAction]}
            labelStyle={[styles.steerLabel, lit && styles.litActionLabel]}
            icon={
              narrow ? null : steers ? (
                <CornerDownRight
                  size={12}
                  color={lit ? colors.bgBase : colors.textPrimary}
                  strokeWidth={2}
                />
              ) : (
                <Send size={12} color={lit ? colors.bgBase : colors.textPrimary} strokeWidth={2} />
              )
            }
            spinnerColor={lit ? colors.bgBase : colors.textPrimary}
            pending={busyControl === 'send'}
            disabled={busy || steerHeld}
            onPress={onSend}
          />
        )}
        <MobilePendingButton
          label={t('session.queuedMessageCardRow.moreActions', 'More actions')}
          iconOnly
          icon={<MoreHorizontal size={16} color={colors.textSecondary} strokeWidth={2} />}
          style={styles.moreButton}
          spinnerColor={colors.textSecondary}
          pending={busyControl === 'more'}
          disabled={busy}
          onPress={onMore}
        />
      </View>
      {returned && card.caption ? (
        <View style={styles.expandedBody}>
          <Text style={[styles.caption, styles.captionReturned]}>{card.caption}</Text>
        </View>
      ) : null}
    </View>
  )
}
