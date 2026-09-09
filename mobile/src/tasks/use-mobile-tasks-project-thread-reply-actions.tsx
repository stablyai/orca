import type { ProjectWorkspaceCommentActionsModel } from './use-mobile-tasks-project-workspace-comment-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubProjectRow,
  commentAuthor,
  isSuccess,
  projectRowGitHubRepository,
  projectRowType,
  splitRepositorySlug
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectThreadReplyActions(
  model: ProjectWorkspaceCommentActionsModel
) {
  const {
    activeGitHubProjectHost,
    client,
    findProjectRowRepo,
    itemReplyDrafts,
    projectEditingCommentId,
    projectMutating,
    setItemReplyDrafts,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    setProjectMutating,
    setProjectRowDetail,
    setProjectRowDetailError
  } = model
  const deleteProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const commentId = Number(comment.id)
      if (!slug || !Number.isInteger(commentId) || commentId <= 0) {
        setProjectRowDetailError('This project comment cannot be deleted from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.project.deleteIssueCommentBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            host: activeGitHubProjectHost,
            commentId
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string | { message?: string }
        }
        if (result.ok === false) {
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : (result.error?.message ?? 'Failed to delete comment')
          )
        }
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
    [activeGitHubProjectHost, client, projectEditingCommentId, projectMutating]
  )

  const toggleProjectGitHubReviewThread = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
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
        const response = await client.sendRequest(
          'github.resolveReviewThread',
          {
            repo: `id:${repo.id}`,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            threadId: comment.threadId,
            resolve
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
        }
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
    [activeGitHubProjectHost, client, findProjectRowRepo, projectMutating]
  )

  const replyToProjectGitHubComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || !repo || !row.content.number) {
        return
      }
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
        const response = canUseReviewReply
          ? await client.sendRequest(
              'github.addPRReviewCommentReply',
              {
                repo: `id:${repo.id}`,
                prNumber: row.content.number,
                prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
                commentId: comment.id,
                body,
                threadId: comment.threadId,
                path: comment.path,
                line: comment.line
              },
              { timeoutMs: 30_000 }
            )
          : await client.sendRequest(
              'github.addIssueComment',
              {
                repo: `id:${repo.id}`,
                number: row.content.number,
                prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
                body: `@${commentAuthor(comment)} ${body}`,
                type: projectRowType(row) ?? 'issue'
              },
              { timeoutMs: 30_000 }
            )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to reply')
        }
        const reply: DetailComment = result.comment ?? {
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
    [activeGitHubProjectHost, client, findProjectRowRepo, itemReplyDrafts, projectMutating]
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
