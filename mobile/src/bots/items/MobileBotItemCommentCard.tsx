// One comment in an item's Activity, as the desktop's card draws it: who and when, the reply it quotes,
// its words with its images and files, a question's lines, and for a comment sent
// from the box that didn't reach the host, Not sent · Retry · Discard.
import { Pressable, Text, View } from 'react-native'
import { CircleAlert } from '../../components/icons/app-icons'
import type { BotItemActivityEntry } from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
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
  failed
}: {
  item: BotItem
  entry: Pick<
    Extract<BotItemActivityEntry, { kind: 'comment' }>,
    'event' | 'replyTo' | 'waiting' | 'answers'
  >
  attachments: MobileBotItemAttachmentSource
  /** A comment sent from the box that didn't reach the host; no Retry when it may have. */
  failed?: { retry: (() => void) | null; discard: () => void }
}) {
  const t = useMobileTranslation()
  const { event, replyTo, waiting } = entry
  const time = useMobileMessageTime()
  const mine = event.actor.kind === 'owner'
  const shape = botItemQuestionShape(event.data)
  const text = mobileBotItemCommentWords({ ...event.data, text: shape.body })
  return (
    <View style={[styles.card, mine && styles.cardMine, failed && styles.cardFailed]}>
      <View style={styles.cardHead}>
        <Text style={[styles.author, styles.shrink]} numberOfLines={1}>
          {botItemActorName(event, item, t)}
        </Text>
        <View style={styles.spacer} />
        <Text style={styles.meta} accessibilityLabel={time.full(event.at)}>
          {time.label(event.at)}
        </Text>
      </View>
      {replyTo ? <MobileBotItemReplyQuote text={replyTo.text} /> : null}
      <MobileBotItemCommentAttachments data={event.data} {...attachments}>
        {text.trim() ? <MobileMarkdown content={text} /> : null}
      </MobileBotItemCommentAttachments>
      {shape.decisions.length > 0 ? (
        <MobileBotItemQuestionLines shape={shape} waiting={waiting} answers={entry.answers} />
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

const styles = themedStyleSheet(() => ({
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
