import type { TaskCreateActionsModel } from './use-mobile-tasks-task-create-actions'
import {
  MobileMarkdown,
  Pressable,
  type ReactNode,
  Text,
  TextInput,
  View,
  colors
} from './mobile-tasks-dependencies'
import { ReplyBox } from '../components/ui/ReplyBox'
import {
  type DetailComment,
  type DetailCommentGroup,
  SHOW_MOBILE_COMMENT_THREAD_TOOLS,
  commentAuthor,
  commentDate,
  commentSourceLabel,
  detailCommentGroupCount,
  detailCommentGroupId,
  detailCommentGroupRoot,
  isResolvedDetailCommentGroup,
  renderCommentReactions
} from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'

export function useMobileTasksDetailCommentRenderers(model: TaskCreateActionsModel) {
  const {
    actionItem,
    detailPayload,
    expandedResolvedCommentGroups,
    itemReplyDrafts,
    mutatingStatus,
    replyToGitHubComment,
    setExpandedResolvedCommentGroups,
    setItemReplyDrafts,
    toggleGitHubReviewThread
  } = model
  const renderCommentComposer = (args: {
    value: string
    onChangeText: (next: string) => void
    onSubmit: () => void
    disabled?: boolean
  }): ReactNode => {
    return (
      <View style={styles.commentComposer}>
        <ReplyBox
          value={args.value}
          onChangeText={args.onChangeText}
          onSend={args.onSubmit}
          placeholder="Add a comment"
          sendAccessibilityLabel="Send comment"
          sending={args.disabled}
        />
      </View>
    )
  }

  const renderDetailComment = (
    comment: DetailComment,
    options: { nested?: boolean } = {}
  ): ReactNode => (
    <View
      key={String(comment.id)}
      style={[
        styles.commentBlock,
        options.nested && styles.commentReplyBlock,
        comment.isResolved && styles.commentResolvedBlock
      ]}
    >
      <Text style={styles.commentSource} numberOfLines={1}>
        {commentSourceLabel(comment)}
      </Text>
      <Text style={styles.commentMeta}>
        {commentAuthor(comment)}
        {commentDate(comment.createdAt) ? ` · ${commentDate(comment.createdAt)}` : ''}
      </Text>
      <MobileMarkdown content={comment.body} />
      {renderCommentReactions(comment)}
      {SHOW_MOBILE_COMMENT_THREAD_TOOLS &&
      actionItem?.provider === 'github' &&
      detailPayload?.provider === 'github' ? (
        <View style={styles.commentControls}>
          {SHOW_MOBILE_COMMENT_THREAD_TOOLS &&
          actionItem?.provider === 'github' &&
          detailPayload?.provider === 'github' ? (
            <>
              {actionItem.source.type === 'pr' && comment.threadId ? (
                <Pressable
                  style={styles.inlineSaveButtonCompact}
                  disabled={mutatingStatus}
                  onPress={() => void toggleGitHubReviewThread(actionItem, comment)}
                >
                  <Text style={styles.inlineSaveText}>
                    {comment.isResolved ? 'Reopen thread' : 'Resolve thread'}
                  </Text>
                </Pressable>
              ) : null}
              <TextInput
                style={[styles.input, styles.replyInput]}
                value={itemReplyDrafts[String(comment.id)] ?? ''}
                onChangeText={(next) =>
                  setItemReplyDrafts((current) => ({
                    ...current,
                    [String(comment.id)]: next
                  }))
                }
                placeholder="Reply"
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
              />
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || !(itemReplyDrafts[String(comment.id)] ?? '').trim()}
                onPress={() => void replyToGitHubComment(actionItem, comment)}
              >
                <Text style={styles.inlineSaveText}>Reply</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  )

  const renderDetailCommentGroup = (group: DetailCommentGroup): ReactNode => {
    const id = detailCommentGroupId(group)
    const root = detailCommentGroupRoot(group)
    const count = detailCommentGroupCount(group)
    const isCollapsedResolved =
      isResolvedDetailCommentGroup(group) && !expandedResolvedCommentGroups.has(id)

    if (isCollapsedResolved) {
      return (
        <Pressable
          key={id}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.resolvedCommentSummary,
            pressed && styles.resolvedCommentSummaryPressed
          ]}
          onPress={() =>
            setExpandedResolvedCommentGroups((current) => {
              const next = new Set(current)
              next.add(id)
              return next
            })
          }
        >
          <Text style={styles.resolvedCommentTitle} numberOfLines={1}>
            Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {commentAuthor(root)}
          </Text>
          <Text style={styles.resolvedCommentAction}>
            {count > 1 ? `Show ${count} comments` : 'Show'}
          </Text>
        </Pressable>
      )
    }

    return (
      <View key={id} style={styles.commentThreadGroup}>
        {group.kind === 'thread'
          ? [
              renderDetailComment(group.root),
              ...group.replies.map((reply) => renderDetailComment(reply, { nested: true }))
            ]
          : renderDetailComment(group.comment)}
      </View>
    )
  }
  return Object.assign(model, {
    renderCommentComposer,
    renderDetailComment,
    renderDetailCommentGroup
  })
}

export type DetailCommentRenderersModel = ReturnType<typeof useMobileTasksDetailCommentRenderers>
