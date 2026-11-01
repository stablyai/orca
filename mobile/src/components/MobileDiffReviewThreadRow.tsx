import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { getPRCommentGroupCount } from '../../../src/shared/pr-comment-groups'
import type { MobileDiffReviewThread } from '../session/mobile-diff-review-github'
import { colors, pressedStyle, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AgentLaunchNotice } from './AgentLaunchNotice'
import { PrThreadRow } from './pr-sidebar/PrThreadRow'
import { prCommentAuthorName } from './pr-sidebar/PrCommentAvatar'
import type { MobileDiffThreadKit } from './use-mobile-diff-review-thread-kit'

// A review thread under its diff line, drawn like the Comments screen's rows; resolved ones fold to one line.
export function MobileDiffReviewThreadRow({
  thread,
  kit,
  now
}: {
  thread: MobileDiffReviewThread
  kit: MobileDiffThreadKit
  now: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [showResolved, setShowResolved] = useState(false)
  const notice =
    kit.launchedThreadId === thread.threadId ? kit.triage.noticeFor('resolve-comments') : null
  if (thread.root.isResolved === true && !showResolved) {
    const count = getPRCommentGroupCount(thread)
    const author = prCommentAuthorName(thread.root.author)
    return (
      <Pressable
        onPress={() => setShowResolved(true)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.resolved, pressed && pressedStyle]}
      >
        <ChevronRight size={14} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.resolvedText} numberOfLines={1}>
          {count === 1
            ? t(
                'pullRequest.commentsSection.resolvedThreadSingle',
                'Resolved thread by {{author}}',
                {
                  author
                }
              )
            : t(
                'pullRequest.commentsSection.resolvedThreadCount',
                'Resolved thread by {{author}} ({{count}})',
                { author, count }
              )}
        </Text>
      </Pressable>
    )
  }
  return (
    <View>
      <PrThreadRow
        group={thread}
        actions={kit.actions}
        botAuthorOverrides={kit.botAuthorOverrides}
        now={now}
        askToFix={kit.askToFix(thread)}
        anchored
      />
      {notice ? (
        <View style={styles.notice}>
          <AgentLaunchNotice
            availability={kit.triage.availability}
            success={notice.success}
            error={notice.error}
            warning={notice.warning}
            undeliveredPrompt={notice.undeliveredPrompt}
            errorStyle={styles.noticeError}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  resolved: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  resolvedText: { color: colors.textSecondary, fontSize: 13, flexShrink: 1 },
  notice: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  noticeError: { color: colors.statusRed, fontSize: 13 }
}))
