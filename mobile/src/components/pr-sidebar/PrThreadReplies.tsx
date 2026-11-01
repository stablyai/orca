import { Pressable, Text, View } from 'react-native'
import type { PRComment } from '../../../../src/shared/github/comment-types'
import { colors, pressedStyle, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { PrCommentAvatar, prCommentAuthorName } from './PrCommentAvatar'
import { commentRelativeTime } from './pr-comment-relative-time'

const REPLY_AVATAR = 20

export type PrInlineReply = {
  submitting: boolean
  onSubmit: (body: string) => Promise<boolean>
  onCancel: () => void
  autoFocus: boolean
}

// A thread's replies: the latest on one line, or every reply plus a reply box where no Thread screen exists.
export function PrThreadReplies({
  replies,
  now,
  expanded,
  onExpand,
  reply
}: {
  replies: readonly PRComment[]
  now: number
  expanded: boolean
  onExpand?: () => void
  reply?: PrInlineReply
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const last = replies.at(-1)
  if (!expanded) {
    if (!last) {
      return null
    }
    const summary = last.body.replaceAll('`', '').trim()
    const line = (
      <Text style={styles.summaryText} numberOfLines={1}>
        <Text style={styles.summaryAuthor}>{prCommentAuthorName(last.author)}</Text>
        {'  '}
        {replies.length > 1
          ? t('pullRequest.screens.replyAndMore', '{{body}} (+{{count}} more)', {
              body: summary,
              count: replies.length - 1
            })
          : summary}
      </Text>
    )
    return onExpand ? (
      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={t('pullRequest.screens.showReplies', 'Show {{count}} replies', {
          count: replies.length
        })}
        style={({ pressed }) => [styles.summary, pressed && pressedStyle]}
      >
        <PrCommentAvatar login={last.author} size={16} />
        {line}
      </Pressable>
    ) : (
      <View style={styles.summary}>
        <PrCommentAvatar login={last.author} size={16} />
        {line}
      </View>
    )
  }
  return (
    <View style={styles.thread}>
      {replies.map((comment) => (
        <View key={comment.id} style={styles.message}>
          <View style={styles.head}>
            <PrCommentAvatar login={comment.author} size={REPLY_AVATAR} />
            <Text style={styles.author} numberOfLines={1}>
              {prCommentAuthorName(comment.author)}
            </Text>
            <Text style={styles.time}>{commentRelativeTime(comment.createdAt, now, t)}</Text>
          </View>
          <View style={styles.body}>
            <CommentMarkdown content={comment.body} />
          </View>
        </View>
      ))}
      {reply ? (
        <PRCommentComposer
          placeholder={t('pullRequest.screens.replyPlaceholder', 'Reply…')}
          submitLabel={t('pullRequest.commentCard.reply', 'Reply')}
          submitting={reply.submitting}
          onSubmit={reply.onSubmit}
          onCancel={reply.onCancel}
          autoFocus={reply.autoFocus}
          inline
        />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  summary: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  summaryText: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  summaryAuthor: { color: colors.textPrimary, fontWeight: '600' },
  thread: { gap: spacing.md },
  message: { gap: spacing.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  author: { color: colors.textPrimary, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  time: { color: colors.textMuted, fontSize: typography.metaSize },
  body: { marginLeft: REPLY_AVATAR + spacing.sm }
}))
