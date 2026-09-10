import type { ProjectWorkspaceCommentActionsModel } from './use-mobile-tasks-project-workspace-comment-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubProjectRow,
  commentAuthor
} from './mobile-tasks-legacy-foundation'
import { projectRowIdentityTarget, projectRowSlugTarget } from './mobile-tasks-mutation-targets'

export function useMobileTasksProjectThreadReplyActions(
  model: ProjectWorkspaceCommentActionsModel
) {
  const {
    activeGitHubProjectHost,
    findProjectRowRepo,
    itemReplyDrafts,
    projectEditingCommentId,
    projectMutating,
    setItemReplyDrafts,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    setProjectMutating,
    setProjectRowDetail,
    setProjectRowDetailError,
    taskOperations
  } = model
  const deleteProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!taskOperations || projectMutating) {
        return
      }
      // Why: `deleteIssueCommentBySlug` addresses by repository and comment id only.
      const target = projectRowSlugTarget(row, activeGitHubProjectHost)
      const commentId = Number(comment.id)
      if (!target || !Number.isInteger(commentId) || commentId <= 0) {
        setProjectRowDetailError('This project comment cannot be deleted from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskOperations.projectMutation.deleteComment(target, commentId)
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.filter((candidate) => Number(candidate.id) !== commentId)
              }
            : current
        )
        if (projectEditingCommentId === String(comment.id)) {
          setProjectEditingCommentId(null)
          setProjectEditingCommentDraft('')
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to delete comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, projectEditingCommentId, projectMutating, taskOperations]
  )

  const toggleProjectGitHubReviewThread = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      // Why: `resolveReviewThread` addresses by repo id and thread id; the slug, number and kind
      // are decoration the host treats as optional.
      const target = projectRowIdentityTarget(row, activeGitHubProjectHost)
      if (
        !taskOperations ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !comment.threadId
      ) {
        return
      }
      const resolve = !comment.isResolved
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskOperations.projectMutation.resolveReviewThread(
          target,
          repo.id,
          comment.threadId,
          resolve
        )
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  candidate.threadId === comment.threadId
                    ? { ...candidate, isResolved: resolve }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update review thread'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, findProjectRowRepo, projectMutating, taskOperations]
  )

  const replyToProjectGitHubComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!taskOperations || projectMutating || !repo || !row.content.number) {
        return
      }
      const target = projectRowIdentityTarget(row, activeGitHubProjectHost)
      const key = String(comment.id)
      const body = (itemReplyDrafts[key] ?? '').trim()
      if (!body) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const canUseReviewReply =
          row.itemType === 'PULL_REQUEST' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
        const posted = await (canUseReviewReply
          ? taskOperations.projectMutation.replyReviewComment(target, repo.id, {
              commentId: comment.id as number,
              body,
              ...(comment.threadId ? { threadId: comment.threadId } : {}),
              path: comment.path as string,
              line: comment.line as number
            })
          : taskOperations.projectMutation.addConversationComment(
              target,
              repo.id,
              `@${commentAuthor(comment)} ${body}`
            ))
        const reply: DetailComment = posted ?? {
          id: `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: 'You',
          path: comment.path,
          line: comment.line,
          threadId: comment.threadId
        }
        setItemReplyDrafts((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, reply] }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to reply')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, findProjectRowRepo, itemReplyDrafts, projectMutating, taskOperations]
  )
  return Object.assign(model, {
    deleteProjectRowComment,
    toggleProjectGitHubReviewThread,
    replyToProjectGitHubComment
  })
}

export type ProjectThreadReplyActionsModel = ReturnType<
  typeof useMobileTasksProjectThreadReplyActions
>
