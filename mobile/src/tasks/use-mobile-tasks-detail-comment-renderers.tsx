import type { TaskCreateActionsModel } from './use-mobile-tasks-task-create-actions'
import {
  MessageBox,
  MobileMarkdown,
  Pressable,
  type ReactNode,
  Text,
  View
} from './mobile-tasks-dependencies'
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
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function useMobileTasksDetailCommentRenderers(model: TaskCreateActionsModel) {
  const t = useMobileTranslation()
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
  }): ReactNode => (
    <MessageBox
      style={styles.stackedInput}
      value={args.value}
      onChangeText={args.onChangeText}
      placeholder={t('tasks.detailCommentRenderers.commentPlaceholder', 'Add a comment')}
      editable={!args.disabled}
      onSend={args.onSubmit}
      canSend={!args.disabled && args.value.trim().length > 0}
      sendAccessibilityLabel={t('tasks.detailCommentRenderers.sendComment', 'Send comment')}
    />
  )

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
                    {comment.isResolved
                      ? t('tasks.detailCommentRenderers.reopenThread', 'Reopen thread')
                      : t('tasks.detailCommentRenderers.resolveThread', 'Resolve thread')}
                  </Text>
                </Pressable>
              ) : null}
              <MessageBox
                value={itemReplyDrafts[String(comment.id)] ?? ''}
                onChangeText={(next) =>
                  setItemReplyDrafts((current) => ({
                    ...current,
                    [String(comment.id)]: next
                  }))
                }
                placeholder={t('tasks.detailCommentRenderers.reply', 'Reply')}
                onSend={() => void replyToGitHubComment(actionItem, comment)}
                canSend={!mutatingStatus && !!(itemReplyDrafts[String(comment.id)] ?? '').trim()}
                sendAccessibilityLabel={t('tasks.detailCommentRenderers.reply', 'Reply')}
              />
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
      const countLabel =
        count === 1
          ? t('tasks.detailCommentRenderers.comments_one', '{{count}} comment', { count })
          : t('tasks.detailCommentRenderers.comments_other', '{{count}} comments', { count })
      return (
        <Pressable
          key={id}
          style={styles.resolvedCommentSummary}
          onPress={() =>
            setExpandedResolvedCommentGroups((current) => {
              const next = new Set(current)
              next.add(id)
              return next
            })
          }
        >
          <Text style={styles.resolvedCommentTitle} numberOfLines={1}>
            {group.kind === 'thread'
              ? t(
                  'tasks.detailCommentRenderers.resolvedThreadBy',
                  'Resolved thread by {{author}}',
                  {
                    author: commentAuthor(root)
                  }
                )
              : t(
                  'tasks.detailCommentRenderers.resolvedCommentBy',
                  'Resolved comment by {{author}}',
                  {
                    author: commentAuthor(root)
                  }
                )}
          </Text>
          <Text style={styles.detailSectionMeta}>
            {count > 1 ? countLabel : t('tasks.detailCommentRenderers.show', 'Show')}
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
