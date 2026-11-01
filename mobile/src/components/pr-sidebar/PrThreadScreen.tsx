import { ScrollView, Text, View } from 'react-native'
import type { PRCommentGroup } from '../../../../src/shared/pr-comment-groups'
import { threadDiffLines } from '../../../../src/shared/github/pr-comment-diff-hunk'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-link'
import { useKeyboardOcclusion } from '../../platform/keyboard-occlusion'
import { isResolvableComment } from '../../session/pr-comment-actions'
import { MobileStateView } from '../MobileStateView'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentComposer } from './PRCommentComposer'
import { PrCommentAvatar } from './PrCommentAvatar'
import { PrMiniButton } from './PrMiniButton'
import { PrThreadCode } from './PrThreadCode'
import {
  PR_COMMENT_AVATAR,
  PR_COMMENT_INDENT,
  PrCommentFileLink,
  prCommentAuthorName,
  prCommentLocation,
  type PrThreadActions
} from './PrThreadRow'
import { commentRelativeTime } from './pr-comment-relative-time'
import { ScreenFrame } from './pr-tab-screen-frame'

// A review thread read like a message thread: where it is, who said what, then a reply box.
export function PrThreadScreen({
  thread,
  actions,
  error,
  focusReply,
  onOpenFile,
  now,
  onBack,
  bottomInset
}: {
  thread: Extract<PRCommentGroup, { kind: 'thread' }> | null
  actions?: PrThreadActions
  /** The last reply/resolve failure; the list that also shows it sits under this screen. */
  error: string | null
  /** Opened from Reply, so the reply box takes focus. */
  focusReply: boolean
  onOpenFile?: (filePath: string) => void
  now: number
  onBack: () => void
  bottomInset: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const keyboardHeight = useKeyboardOcclusion()
  if (!thread) {
    return (
      <ScreenFrame
        title={t('pullRequest.screens.thread', 'Thread')}
        onBack={onBack}
        backLabel={t('pullRequest.screens.backToComments', 'Back to comments')}
      >
        <MobileStateView
          title={t(
            'pullRequest.screens.threadGone',
            'This thread is no longer on the pull request.'
          )}
        />
      </ScreenFrame>
    )
  }
  const { root, replies } = thread
  const messages = [root, ...replies]
  const location = prCommentLocation(root)
  const filePath = root.path
  const canResolve = actions !== undefined && isResolvableComment(root)
  return (
    <ScreenFrame
      title={t('pullRequest.screens.thread', 'Thread')}
      subtitle={
        messages.length === 1
          ? t('pullRequest.screens.threadSubtitle_one', '{{author}} · {{count}} message', {
              author: prCommentAuthorName(root.author),
              count: 1
            })
          : t('pullRequest.screens.threadSubtitle_other', '{{author}} · {{count}} messages', {
              author: prCommentAuthorName(root.author),
              count: messages.length
            })
      }
      onBack={onBack}
      backLabel={t('pullRequest.screens.backToComments', 'Back to comments')}
      trailing={
        canResolve ? (
          <PrMiniButton
            label={
              root.isResolved
                ? t('pullRequest.commentCard.unresolve', 'Unresolve')
                : t('pullRequest.commentCard.resolve', 'Resolve')
            }
            onPress={() => void actions.toggleResolve(root)}
            busy={root.threadId ? actions.isResolveBusy(root.threadId) : false}
          />
        ) : undefined
      }
      footer={
        actions ? (
          <View
            style={[
              styles.composerBar,
              keyboardHeight > 0
                ? { marginBottom: keyboardHeight, paddingBottom: spacing.sm }
                : { paddingBottom: Math.max(bottomInset, spacing.md) }
            ]}
          >
            <PRCommentComposer
              placeholder={t('pullRequest.screens.replyPlaceholder', 'Reply…')}
              submitLabel={t('pullRequest.commentCard.reply', 'Reply')}
              submitting={actions.isReplyBusy(root.id)}
              onSubmit={(body) => actions.reply(root, body)}
              autoFocus={focusReply}
              inline
            />
          </View>
        ) : null
      }
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {location ? (
          <PrCommentFileLink
            location={location}
            onPress={
              filePath && onOpenFile
                ? () => onOpenFile(filePath)
                : root.url
                  ? () => openExternalLink(root.url)
                  : undefined
            }
          />
        ) : null}
        {root.diffHunk && root.line ? (
          <PrThreadCode lines={threadDiffLines(root.diffHunk, root.line, root.startLine)} />
        ) : null}
        {messages.map((comment) => (
          <View key={comment.id} style={styles.message}>
            <View style={styles.head}>
              <PrCommentAvatar login={comment.author} size={PR_COMMENT_AVATAR} />
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
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </ScreenFrame>
  )
}

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.lg },
  message: { gap: spacing.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  author: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  time: { color: colors.textMuted, fontSize: typography.metaSize },
  body: { marginLeft: PR_COMMENT_INDENT },
  error: { color: colors.statusRed, fontSize: 13 },
  composerBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.bgBase
  }
}))
