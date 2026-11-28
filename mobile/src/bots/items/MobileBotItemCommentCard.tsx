// One comment in an item's Activity, on its own card: a face, who and when on one line, the reply it
// quotes, its words at chat's prose size with its images and files, a question's lines, and for a comment
// sent from the box that didn't reach the host, Not sent · Retry · Discard.
import { useEffect, useRef, type Ref } from 'react'
import { Animated, Pressable, Text, View, type HostInstance } from 'react-native'
import { CircleAlert, UserRound } from 'lucide-react-native'
import type { BotItemActivityEntry } from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { botInitial } from '../../../../src/shared/bots/bot-avatar-fallback'
import type { BotItemSentAnswers } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { PrCommentAvatar } from '../../source-control/review/pull-request/comments/PrCommentAvatar'
import { MobileBotAvatar } from '../MobileBotAvatar'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileNativeChatMarkdown } from '../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { radii, spacing, typography } from '../../theme/mobile-theme'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import {
  mobileBotItemCommentWords,
  MobileBotItemCommentAttachments,
  type MobileBotItemAttachmentSource
} from './MobileBotItemCommentAttachments'
import { MobileBotItemQuestionLines } from './MobileBotItemQuestionLines'
import { MobileBotItemReplyQuote } from './MobileBotItemReplyQuote'
import { useBotItemProseScale } from './bot-item-prose-scale'
import { useMobileMessageTime } from '../../session/native-chat/transcript/messages/use-mobile-message-time'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

const ICON = 13
const FACE = 24
// Two cards sit this far apart: half of it each side.
const CARD_GAP = spacing.md

/** Who wrote it, as the desktop's comment draws them: the item's bot its picture, you your mark, anyone
 *  else their initial. */
function CommentFace({
  event,
  item,
  name,
  botAvatar
}: {
  event: BotItemEvent
  item: BotItem
  name: string
  botAvatar: MobileBotAvatarSource
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const { actor } = event
  if (actor.kind === 'bot' && actor.botId === item.owner.botId) {
    return <MobileBotAvatar avatar={botAvatar} size={FACE} circular />
  }
  if (actor.kind === 'owner') {
    return (
      <View style={styles.ownFace}>
        <UserRound size={14} color={colors.textSecondary} strokeWidth={2.2} />
      </View>
    )
  }
  return <PrCommentAvatar login={name} label={botInitial(name)} size={FACE} />
}

export function MobileBotItemCommentCard({
  item,
  entry,
  attachments,
  botAvatar,
  failed,
  ref,
  onShowQuestion,
  onShowLive,
  flash,
  sent,
  asking = false
}: {
  item: BotItem
  entry: Pick<Extract<BotItemActivityEntry, { kind: 'comment' }>, 'event' | 'replyTo' | 'waiting'> &
    Partial<
      Pick<
        Extract<BotItemActivityEntry, { kind: 'comment' }>,
        'answers' | 'byOrder' | 'ended' | 'beside'
      >
    >
  attachments: MobileBotItemAttachmentSource
  /** The item's bot's picture, beside its own comments. */
  botAvatar: MobileBotAvatarSource
  /** A comment sent from the box that didn't reach the host; no Retry when it may have. */
  failed?: { retry: (() => void) | null; discard: () => void }
  ref?: Ref<HostInstance>
  /** Its quote's tap; null while the question isn't in the Activity read so far. */
  onShowQuestion?: (() => void) | null
  /** Replaced: shows the ask that waits now; null when none waits. */
  onShowLive?: (() => void) | null
  /** Shown from a reply's quote: a brief highlight, again for each new `at`; `end` stays the same. */
  flash?: { at: number; still: boolean; end: () => void }
  /** Answers just posted as one comment, shown on their question's lines. */
  sent?: BotItemSentAnswers | null
  /** The docked answer card asks this comment's open lines now. */
  asking?: boolean
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const { event, replyTo, waiting } = entry
  const time = useMobileMessageTime()
  const proseScale = useBotItemProseScale()
  const shape = botItemQuestionShape(event.data)
  const text = mobileBotItemCommentWords({ ...event.data, text: entry.beside ?? shape.body })
  const name = botItemActorName(event, item, t)
  return (
    <View ref={ref} style={styles.card}>
      {flash ? <CommentFlash key={flash.at} still={flash.still} end={flash.end} /> : null}
      <View style={styles.body}>
        <View style={styles.head}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
          >
            <CommentFace event={event} item={item} name={name} botAvatar={botAvatar} />
          </View>
          {/* The time right after the name, on its baseline; a long name gives way first. */}
          <View style={styles.byline}>
            <Text style={styles.author} numberOfLines={1}>
              {name}
            </Text>
            {/* Its own text, spaced by the row's gap: a space inside would land on the wrong side in RTL. */}
            <Text style={styles.meta} accessibilityElementsHidden importantForAccessibility="no">
              ·
            </Text>
            <Text style={styles.meta} accessibilityLabel={time.full(event.at)}>
              {time.label(event.at)}
            </Text>
          </View>
        </View>
        {replyTo ? (
          <MobileBotItemReplyQuote text={replyTo.text} onShowQuestion={onShowQuestion ?? null} />
        ) : null}
        <MobileBotItemCommentAttachments data={event.data} {...attachments}>
          {text.trim() ? (
            <MobileNativeChatMarkdown
              content={text}
              rangeSelectable={INLINE_TEXT_SELECTION}
              textScale={proseScale}
            />
          ) : null}
        </MobileBotItemCommentAttachments>
        {shape.decisions.length > 0 ? (
          <MobileBotItemQuestionLines
            shape={shape}
            askId={event.id}
            waiting={waiting}
            answers={entry.answers}
            byOrder={entry.byOrder}
            ended={entry.ended}
            onShowLive={onShowLive ?? undefined}
            sent={sent}
            asking={asking}
          />
        ) : null}
        {failed ? (
          <View style={styles.failed}>
            <CircleAlert size={ICON} color={colors.statusRed} />
            <Text style={[styles.line, styles.notSent]}>
              {failed.retry
                ? t('bots.items.activity.notSent', 'Not sent.')
                : t('bots.items.activity.mayHaveArrived', 'May have arrived.')}
            </Text>
            {failed.retry ? (
              <Pressable onPress={failed.retry} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.line, styles.retry]}>
                  {t('bots.items.activity.retry', 'Retry')}
                </Text>
              </Pressable>
            ) : null}
            <Pressable onPress={failed.discard} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.line}>{t('bots.items.activity.discard', 'Discard')}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  )
}

// The desktop's: held, then easing out; with reduced motion it holds a little longer and goes at once.
const FLASH_HOLD_MS = 1200
const FLASH_FADE_MS = 600
const FLASH_STILL_MS = 1600

/** The desktop's ring and tint, under the card's content. */
function CommentFlash({ still, end }: { still: boolean; end: () => void }) {
  const styles = useThemedStyles(stylesSheet)
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const run = still
      ? Animated.delay(FLASH_STILL_MS)
      : Animated.sequence([
          Animated.delay(FLASH_HOLD_MS),
          Animated.timing(opacity, { toValue: 0, duration: FLASH_FADE_MS, useNativeDriver: true })
        ])
    run.start(({ finished }) => {
      if (finished) {
        end()
      }
    })
    return () => run.stop()
  }, [opacity, still, end])
  return <Animated.View pointerEvents="none" style={[styles.flash, { opacity }]} />
}

// A card as wide as the Status and Chat group, on its fill and curve; its words on the rows' inset, so they
// line up with the row titles and the Activity header. Event lines sit outside cards.
const stylesSheet = themedStyleSheet((colors) => ({
  flash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.surface,
    backgroundColor: colors.translucentFill
  },
  card: {
    marginVertical: CARD_GAP / 2,
    paddingVertical: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  },
  body: { flex: 1, minWidth: 0, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  byline: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs
  },
  ownFace: {
    width: FACE,
    height: FACE,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  author: {
    flexShrink: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.textPrimary
  },
  failed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  notSent: { color: colors.statusRed },
  retry: { fontWeight: '600', color: colors.textPrimary },
  line: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  meta: {
    flexShrink: 0,
    fontSize: typography.bodySize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
