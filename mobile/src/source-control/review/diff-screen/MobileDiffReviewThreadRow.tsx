import { Pressable, StyleSheet, Text } from 'react-native'
import { Check } from 'lucide-react-native'
import { isResolvedPRCommentGroup } from '../../../../../src/shared/source-control/review-comments/pr-comment-groups'
import { colors, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileDiffReviewThread } from '../diff-actions/mobile-diff-review-github'
import {
  PrThreadRow,
  prCommentAuthorName,
  type PrThreadActions
} from '../pull-request/comments/PrThreadRow'

const NO_BOT_OVERRIDES: ReadonlySet<string> = new Set()

// A GitHub thread under its line, as the Comments page shows it; a resolved one is a single quiet line.
export function MobileDiffReviewThreadRow({
  thread,
  actions,
  now,
  onOpenThread
}: {
  thread: MobileDiffReviewThread
  actions: PrThreadActions | undefined
  now: number
  onOpenThread: (focusReply: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (!isResolvedPRCommentGroup(thread)) {
    return (
      <PrThreadRow
        group={thread}
        actions={actions}
        botAuthorOverrides={NO_BOT_OVERRIDES}
        now={now}
        onOpenThread={onOpenThread}
        atLine
      />
    )
  }
  const author = prCommentAuthorName(thread.root.author)
  const count = thread.replies.length + 1
  return (
    <Pressable
      style={({ pressed }) => [styles.resolved, pressed && styles.pressed]}
      onPress={() => onOpenThread(false)}
      accessibilityRole="button"
    >
      <Check size={14} color={colors.textMuted} strokeWidth={2.2} />
      <Text style={styles.resolvedText} numberOfLines={1}>
        {count === 1
          ? t('pullRequest.commentsSection.resolvedThreadSingle', 'Resolved thread by {{author}}', {
              author
            })
          : t(
              'pullRequest.commentsSection.resolvedThreadCount',
              'Resolved thread by {{author}} ({{count}})',
              { author, count }
            )}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  resolved: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pressed: { backgroundColor: colors.translucentFill },
  resolvedText: { flex: 1, color: colors.textSecondary, fontSize: 13 }
}))
