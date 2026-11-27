import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { View, Text, Pressable } from 'react-native'
import type { ReactNode } from 'react'
import type { Translate } from '../../i18n/mobile-i18n'
import { MessageBox } from '../../components/composer-input/MessageBox'
import { pressedStyle } from '../../theme/mobile-theme'
import { X } from 'lucide-react-native'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { composerInputStylesSheet } from '../../components/composer-input/composer-input-styles'
import {
  discussionSummary,
  detailCommentGroupId,
  detailCommentGroupRoot,
  detailCommentGroupCount,
  isResolvedDetailCommentGroup,
  commentAuthor,
  commentSourceLabel,
  commentDate,
  renderCommentReactions
} from '../item-detail/mobile-tasks-item-comments'
import type { DetailComment } from '../mobile-tasks-provider-detail-types'
import { SHOW_MOBILE_COMMENT_THREAD_TOOLS } from '../task-list/mobile-tasks-options'
import { projectRowType } from '../item-detail/mobile-tasks-item-mapping'

function resolvedCommentCountLabel(t: Translate, count: number): string {
  return count === 1
    ? t('tasks.projectComments.comments_one', '{{count}} comment', { count })
    : t('tasks.projectComments.comments_other', '{{count}} comments', { count })
}

export function renderMobileTasksProjectComments(model: ConnectionPresentationModel) {
  const {
    colorScheme,
    colors,
    styles,
    t,
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
  const composerStyles = composerInputStylesSheet.resolve(colorScheme)
  if (!projectRowItem) {
    return null
  }
  return projectRowDetail?.provider === 'github' ? (
    <View style={styles.detailSection}>
      <View style={styles.detailSectionHeader}>
        <Text style={styles.detailSectionTitle}>
          {t('tasks.projectComments.discussion', 'Discussion')}
        </Text>
        <Text style={styles.detailSectionMeta}>
          {discussionSummary(t, projectRowDetail.comments.length)}
        </Text>
      </View>
      {projectRowDetail.comments.length === 0 ? (
        <Text style={styles.detailMuted}>
          {t('tasks.projectComments.noComments', 'No comments.')}
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
                style={({ pressed }) => [styles.resolvedCommentSummary, pressed && pressedStyle]}
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
                    ? t('tasks.projectComments.resolvedThreadBy', 'Resolved thread by {{author}}', {
                        author: commentAuthor(root)
                      })
                    : t(
                        'tasks.projectComments.resolvedCommentBy',
                        'Resolved comment by {{author}}',
                        {
                          author: commentAuthor(root)
                        }
                      )}
                </Text>
                <Text style={styles.detailSectionMeta}>
                  {count > 1
                    ? resolvedCommentCountLabel(t, count)
                    : t('tasks.projectComments.show', 'Show')}
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
                    placeholder={t('tasks.projectComments.editComment', 'Edit comment')}
                    onSend={() => void updateProjectRowComment(projectRowItem, comment)}
                    canSend={!projectMutating && projectEditingCommentDraft.trim().length > 0}
                    sendAccessibilityLabel={t('common.save', 'Save')}
                    trailing={
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel', 'Cancel')}
                        disabled={projectMutating}
                        style={({ pressed }) => [
                          composerStyles.ghostButton,
                          projectMutating && composerStyles.disabled,
                          pressed && composerStyles.pressed
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
                    {renderCommentReactions(styles, comment)}
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
                          placeholder={t('tasks.projectComments.reply', 'Reply')}
                          onSend={() => void replyToProjectGitHubComment(projectRowItem, comment)}
                          canSend={!projectMutating && !!(itemReplyDrafts[commentId] ?? '').trim()}
                          sendAccessibilityLabel={t('tasks.projectComments.reply', 'Reply')}
                        />
                        <View style={[styles.inlineActionRow, styles.stackedInput]}>
                          {projectRowType(projectRowItem) === 'pr' && comment.threadId ? (
                            <Pressable
                              style={({ pressed }) => [
                                styles.inlineSaveButtonCompact,
                                pressed && pressedStyle
                              ]}
                              disabled={projectMutating}
                              onPress={() =>
                                void toggleProjectGitHubReviewThread(projectRowItem, comment)
                              }
                            >
                              <Text style={styles.inlineSaveText}>
                                {comment.isResolved
                                  ? t('tasks.projectComments.reopenThread', 'Reopen thread')
                                  : t('tasks.projectComments.resolveThread', 'Resolve thread')}
                              </Text>
                            </Pressable>
                          ) : null}
                          <Pressable
                            style={({ pressed }) => [
                              styles.inlineSaveButtonCompact,
                              pressed && pressedStyle
                            ]}
                            disabled={projectMutating}
                            onPress={() => {
                              setProjectEditingCommentId(commentId)
                              setProjectEditingCommentDraft(comment.body)
                            }}
                          >
                            <Text style={styles.inlineSaveText}>{t('common.edit', 'Edit')}</Text>
                          </Pressable>
                          <Pressable
                            style={({ pressed }) => [
                              styles.inlineSaveButtonCompact,
                              pressed && pressedStyle
                            ]}
                            disabled={projectMutating}
                            onPress={() => void deleteProjectRowComment(projectRowItem, comment)}
                          >
                            <Text style={styles.inlineDeleteText}>
                              {t('common.delete', 'Delete')}
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
