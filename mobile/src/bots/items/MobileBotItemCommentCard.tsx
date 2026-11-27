// One comment in an item's Activity, as a chat-style row on the Activity's grid: a glyph, who, Quote and
// when, the reply it quotes, its words with its images and files, a question's lines, and for a comment sent
// from the box that didn't reach the host, Not sent · Retry · Discard.
import { useEffect, useRef, type Ref } from 'react'
import { Animated, Pressable, Text, View, type HostInstance } from 'react-native'
import { CircleAlert, MessageSquare, Quote } from 'lucide-react-native'
import type { BotItemActivityEntry } from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import type { BotItemSentAnswers } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileNativeChatMarkdown } from '../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import {
  mobileBotItemCommentWords,
  MobileBotItemCommentAttachments,
  type MobileBotItemAttachmentSource
} from './MobileBotItemCommentAttachments'
import { MobileBotItemQuestionLines } from './MobileBotItemQuestionLines'
import { MobileBotItemReplyQuote } from './MobileBotItemReplyQuote'
import { useMobileMessageTime } from '../../session/native-chat/transcript/messages/use-mobile-message-time'

const ICON = 13

export function MobileBotItemCommentCard({
  item,
  entry,
  attachments,
  failed,
  ref,
  onShowQuestion,
  onShowLive,
  flash,
  sent,
  asking = false,
  onQuote
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
  /** Puts the comment's words in the comment box as a quote. */
  onQuote?: (text: string) => void
}) {
  const t = useMobileTranslation()
  const { event, replyTo, waiting } = entry
  const time = useMobileMessageTime()
  const shape = botItemQuestionShape(event.data)
  const text = mobileBotItemCommentWords({ ...event.data, text: entry.beside ?? shape.body })
  // A question's lines too, as the agent wrote them.
  const quoted = onQuote
    ? mobileBotItemCommentWords(
        entry.beside === undefined ? event.data : { ...event.data, text: entry.beside }
      ).trim()
    : ''
  return (
    <View ref={ref} style={styles.row}>
      {flash ? <CommentFlash key={flash.at} still={flash.still} end={flash.end} /> : null}
      <View style={styles.icon}>
        {failed ? (
          <CircleAlert size={ICON} color={colors.statusRed} />
        ) : (
          <MessageSquare size={ICON} color={colors.textMuted} />
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={styles.author} numberOfLines={1}>
            {botItemActorName(event, item, t)}
          </Text>
          {onQuote && quoted ? (
            <Pressable
              style={({ pressed }) => [styles.quote, pressed && styles.pressed]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('chat.selectionQuote.action', 'Quote')}
              onPress={() => onQuote(quoted)}
            >
              <Quote size={14} color={colors.textMuted} />
            </Pressable>
          ) : null}
          <Text style={styles.meta} accessibilityLabel={time.full(event.at)}>
            {time.label(event.at)}
          </Text>
        </View>
        {replyTo ? (
          <MobileBotItemReplyQuote text={replyTo.text} onShowQuestion={onShowQuestion ?? null} />
        ) : null}
        <MobileBotItemCommentAttachments data={event.data} {...attachments}>
          {text.trim() ? (
            <MobileNativeChatMarkdown content={text} rangeSelectable={INLINE_TEXT_SELECTION} />
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

// The Activity event line's grid (MobileBotItemActivity): its glyph column, gap and time.
const styles = themedStyleSheet(() => ({
  flash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.control,
    backgroundColor: colors.translucentFill
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.xs
  },
  icon: { width: 16, height: 18, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: spacing.xxs },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // Chat's 24 pt message action box around its 14 pt glyph, pulled back so the 18 pt line keeps its height
  // and the glyph sits the line's gap from the name and the time.
  quote: {
    width: 24,
    height: 24,
    marginVertical: -3,
    marginHorizontal: -5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised },
  author: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.textPrimary },
  failed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  notSent: { color: colors.statusRed },
  retry: { fontWeight: '600', color: colors.textPrimary },
  line: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
