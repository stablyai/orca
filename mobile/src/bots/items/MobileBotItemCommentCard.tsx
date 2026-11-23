// One comment in an item's Activity, as the desktop's card draws it: who and when, the reply it quotes,
// its words with its images and files, a question's lines, and for a comment sent
// from the box that didn't reach the host, Not sent · Retry · Discard. While the item waits on its
// question, the asking comment stands out: a Needs you tag by its time and its question ruled off.
import { useEffect, useRef, type Ref } from 'react'
import { Animated, Pressable, Text, View, type HostInstance } from 'react-native'
import { CircleAlert } from '../../components/icons/app-icons'
import type { BotItemActivityEntry } from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import {
  botItemHeldAnswersScope,
  type BotItemQuickReplyActions
} from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
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
  flash,
  itemScope,
  quickReplies,
  repliesDisabled = false
}: {
  item: BotItem
  entry: Pick<Extract<BotItemActivityEntry, { kind: 'comment' }>, 'event' | 'replyTo' | 'waiting'> &
    Partial<Pick<Extract<BotItemActivityEntry, { kind: 'comment' }>, 'answers' | 'byOrder'>>
  attachments: MobileBotItemAttachmentSource
  /** A comment sent from the box that didn't reach the host; no Retry when it may have. */
  failed?: { retry: (() => void) | null; discard: () => void }
  ref?: Ref<HostInstance>
  /** Its quote's tap; null while the question isn't in the Activity read so far. */
  onShowQuestion?: (() => void) | null
  /** Shown from a reply's quote: a brief highlight, again for each new `at`; `end` stays the same. */
  flash?: { at: number; still: boolean; end: () => void }
  /** The item on its host, which an ask's held answers are kept under. */
  itemScope?: string
  /** On the question the item waits on, until the owner replies. */
  quickReplies?: BotItemQuickReplyActions
  /** The host can't take a comment now (offline). */
  repliesDisabled?: boolean
}) {
  const t = useMobileTranslation()
  const { event, replyTo, waiting } = entry
  const time = useMobileMessageTime()
  const mine = event.actor.kind === 'owner'
  const shape = botItemQuestionShape(event.data)
  const text = mobileBotItemCommentWords({ ...event.data, text: shape.body })
  const asks = shape.decisions.length > 0
  return (
    <View
      ref={ref}
      style={[
        styles.card,
        mine && styles.cardMine,
        failed && styles.cardFailed,
        asks && styles.cardAsks
      ]}
    >
      {flash ? <CommentFlash key={flash.at} still={flash.still} end={flash.end} /> : null}
      <View style={styles.cardHead}>
        <Text style={[styles.author, styles.shrink]} numberOfLines={1}>
          {botItemActorName(event, item, t)}
        </Text>
        <View style={styles.spacer} />
        {waiting ? <NeedsYouTag /> : null}
        <Text style={styles.meta} accessibilityLabel={time.full(event.at)}>
          {time.label(event.at)}
        </Text>
      </View>
      {replyTo ? (
        <MobileBotItemReplyQuote text={replyTo.text} onShowQuestion={onShowQuestion ?? null} />
      ) : null}
      <MobileBotItemCommentAttachments data={event.data} {...attachments}>
        {text.trim() ? <MobileMarkdown content={text} /> : null}
      </MobileBotItemCommentAttachments>
      {asks ? (
        <MobileBotItemQuestionLines
          shape={shape}
          askId={event.id}
          heldScope={
            itemScope && shape.decisions.length > 1
              ? botItemHeldAnswersScope(itemScope, event.id)
              : undefined
          }
          waiting={waiting}
          answers={entry.answers}
          byOrder={entry.byOrder}
          actions={quickReplies}
          disabled={repliesDisabled}
          // Ruled off only below something: a question with no body stays under the name.
          style={waiting && shape.body.trim() ? styles.questionRule : undefined}
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
  )
}

function NeedsYouTag() {
  const t = useMobileTranslation()
  return (
    <View style={styles.tag}>
      <View style={styles.tagDot} />
      <Text style={styles.tagText} numberOfLines={1}>
        {t('bots.items.status.needsYou', 'Needs you')}
      </Text>
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

const styles = themedStyleSheet(() => ({
  flash: {
    position: 'absolute',
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: radii.surface,
    borderWidth: 2,
    borderColor: colors.inputBorder,
    backgroundColor: colors.translucentFill
  },
  card: {
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup
  },
  cardMine: { backgroundColor: colors.bgRaised },
  // A question's chips end the card: more room under them.
  cardAsks: { paddingBottom: spacing.lg },
  // Across the card's full width, its words still on the body's edge.
  questionRule: {
    marginTop: 10,
    marginHorizontal: -spacing.md,
    paddingTop: 10,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.agentQuestionTint
  },
  tagDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: colors.agentQuestion },
  tagText: { fontSize: 11, lineHeight: 16, fontWeight: '600', color: colors.agentQuestionText },
  cardFailed: { borderColor: colors.statusRed },
  failed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  notSent: { color: colors.statusRed },
  retry: { fontWeight: '600', color: colors.textPrimary },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs
  },
  author: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  shrink: { flexShrink: 1 },
  line: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 }
}))
