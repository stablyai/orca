import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  View,
  Text,
  Pressable,
  type ReactNode,
  MessageBox,
  colors,
  X,
  MobileMarkdown
} from './mobile-tasks-dependencies'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { styles } from './mobile-tasks-legacy-styles'
import {
  discussionSummary,
  detailCommentGroupId,
  detailCommentGroupRoot,
  detailCommentGroupCount,
  isResolvedDetailCommentGroup,
  commentAuthor,
  type DetailComment,
  SHOW_MOBILE_COMMENT_THREAD_TOOLS,
  commentSourceLabel,
  commentDate,
  renderCommentReactions,
  projectRowType
} from './mobile-tasks-legacy-foundation'

function resolvedCommentCountLabel(count: number): string {
  return count === 1
    ? translate('tasks.projectComments.comments_one', '{{count}} comment', { count })
    : translate('tasks.projectComments.comments_other', '{{count}} comments', { count })
}

export function renderMobileTasksProjectComments(model: ConnectionPresentationModel) {
  const {
    addProjectRowComment,
    deleteProjectRowComment,
    expandedResolvedCommentGroups,
    itemReplyDrafts,
    projectCommentDraft,
    projectDetailCommentGroups,
    projectEditingCommentDraft,
    projectEditingCommentId,
    projectMutating,
    projectRowDetail,
    projectRowItem,
    renderCommentComposer,
    replyToProjectGitHubComment,
    setExpandedResolvedCommentGroups,
    setItemReplyDrafts,
    setProjectCommentDraft,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    toggleProjectGitHubReviewThread,
    updateProjectRowComment
  } = model
  if (!projectRowItem) {
    return null
  }
  return projectRowDetail?.provider === 'github' ? (
    <View style={styles.detailSection}>
      <View style={styles.detailSectionHeader}>
        <Text style={styles.detailSectionTitle}>
          {translate('tasks.projectComments.discussion', 'Discussion')}
        </Text>
        <Text style={styles.detailSectionMeta}>
          {discussionSummary(projectRowDetail.comments.length)}
        </Text>
      </View>
      {projectRowDetail.comments.length === 0 ? (
        <Text style={styles.detailMuted}>
          {translate('tasks.projectComments.noComments', 'No comments.')}
        </Text>
      ) : (
        projectDetailCommentGroups.map((group) => {
          const groupId = detailCommentGroupId(group)
          const root = detailCommentGroupRoot(group)
          const count = detailCommentGroupCount(group)
          const isCollapsedResolved =
            isResolvedDetailCommentGroup(group) && !expandedResolvedCommentGroups.has(groupId)
          if (isCollapsedResolved) {
            return (
              <Pressable
                key={groupId}
                style={styles.resolvedCommentSummary}
                onPress={() =>
                  setExpandedResolvedCommentGroups((current) => {
                    const next = new Set(current)
                    next.add(groupId)
                    return next
                  })
                }
              >
                <Text style={styles.resolvedCommentTitle} numberOfLines={1}>
                  {group.kind === 'thread'
                    ? translate(
                        'tasks.projectComments.resolvedThreadBy',
                        'Resolved thread by {{author}}',
                        {
                          author: commentAuthor(root)
                        }
                      )
                    : translate(
                        'tasks.projectComments.resolvedCommentBy',
                        'Resolved comment by {{author}}',
                        {
                          author: commentAuthor(root)
                        }
                      )}
                </Text>
                <Text style={styles.detailSectionMeta}>
                  {count > 1
                    ? resolvedCommentCountLabel(count)
                    : translate('tasks.projectComments.show', 'Show')}
                </Text>
              </Pressable>
            )
          }

          const renderProjectComment = (
            comment: DetailComment,
            options: { nested?: boolean } = {}
          ): ReactNode => {
            const commentId = String(comment.id)
            const isEditingComment =
              SHOW_MOBILE_COMMENT_THREAD_TOOLS && projectEditingCommentId === commentId
            return (
              <View
                key={commentId}
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
                {isEditingComment ? (
                  <MessageBox
                    style={styles.stackedInput}
                    value={projectEditingCommentDraft}
                    onChangeText={setProjectEditingCommentDraft}
                    placeholder={translate('tasks.projectComments.editComment', 'Edit comment')}
                    onSend={() => void updateProjectRowComment(projectRowItem, comment)}
                    canSend={!projectMutating && projectEditingCommentDraft.trim().length > 0}
                    sendAccessibilityLabel={translate('common.save', 'Save')}
                    trailing={
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={translate('common.cancel', 'Cancel')}
                        disabled={projectMutating}
                        style={({ pressed }) => [
                          composerInputStyles.ghostButton,
                          projectMutating && composerInputStyles.disabled,
                          pressed && composerInputStyles.pressed
                        ]}
                        onPress={() => {
                          setProjectEditingCommentId(null)
                          setProjectEditingCommentDraft('')
                        }}
                      >
                        <X size={18} color={colors.textSecondary} strokeWidth={2} />
                      </Pressable>
                    }
                  />
                ) : (
                  <>
                    <MobileMarkdown content={comment.body} />
                    {renderCommentReactions(comment)}
                    {SHOW_MOBILE_COMMENT_THREAD_TOOLS ? (
                      <>
                        <MessageBox
                          style={styles.stackedInput}
                          value={itemReplyDrafts[commentId] ?? ''}
                          onChangeText={(next) =>
                            setItemReplyDrafts((current) => ({
                              ...current,
                              [commentId]: next
                            }))
                          }
                          placeholder={translate('tasks.projectComments.reply', 'Reply')}
                          onSend={() => void replyToProjectGitHubComment(projectRowItem, comment)}
                          canSend={!projectMutating && !!(itemReplyDrafts[commentId] ?? '').trim()}
                          sendAccessibilityLabel={translate('tasks.projectComments.reply', 'Reply')}
                        />
                        <View style={[styles.inlineActionRow, styles.stackedInput]}>
                          {projectRowType(projectRowItem) === 'pr' && comment.threadId ? (
                            <Pressable
                              style={styles.inlineSaveButtonCompact}
                              disabled={projectMutating}
                              onPress={() =>
                                void toggleProjectGitHubReviewThread(projectRowItem, comment)
                              }
                            >
                              <Text style={styles.inlineSaveText}>
                                {comment.isResolved
                                  ? translate('tasks.projectComments.reopenThread', 'Reopen thread')
                                  : translate(
                                      'tasks.projectComments.resolveThread',
                                      'Resolve thread'
                                    )}
                              </Text>
                            </Pressable>
                          ) : null}
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            disabled={projectMutating}
                            onPress={() => {
                              setProjectEditingCommentId(commentId)
                              setProjectEditingCommentDraft(comment.body)
                            }}
                          >
                            <Text style={styles.inlineSaveText}>
                              {translate('common.edit', 'Edit')}
                            </Text>
                          </Pressable>
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            disabled={projectMutating}
                            onPress={() => void deleteProjectRowComment(projectRowItem, comment)}
                          >
                            <Text style={styles.inlineDeleteText}>
                              {translate('common.delete', 'Delete')}
                            </Text>
                          </Pressable>
                        </View>
                      </>
                    ) : null}
                  </>
                )}
              </View>
            )
          }

          return (
            <View key={groupId} style={styles.commentThreadGroup}>
              {group.kind === 'thread'
                ? [
                    renderProjectComment(group.root),
                    ...group.replies.map((reply) => renderProjectComment(reply, { nested: true }))
                  ]
                : renderProjectComment(group.comment)}
            </View>
          )
        })
      )}
      {renderCommentComposer({
        value: projectCommentDraft,
        onChangeText: setProjectCommentDraft,
        disabled: projectMutating,
        onSubmit: () => void addProjectRowComment(projectRowItem)
      })}
    </View>
  ) : null
}
