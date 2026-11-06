import { githubTaskKey, requireGitHubTaskTarget } from './github-task-identity'
import type { GithubCheckFileActionsModel } from './use-mobile-tasks-github-check-file-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  githubIssueCommentWrite,
  githubReviewCommentReplyWrite
} from './mobile-task-item-comment-operations'
import {
  githubPullRequestMerge,
  gitlabMergeRequestMerge,
  linearIssueUpdate
} from './mobile-task-item-state-operations'
import {
  type DetailComment,
  type HostedReviewMergeMethod,
  type LinearState,
  type TaskItem,
  commentAuthor,
  createLinearTask,
  isGitHubPrMergeBlocked
} from './mobile-tasks-legacy-foundation'

export type useMobileTasksGithubReplyMergeActionsInput = Pick<
  GithubCheckFileActionsModel,
  | 'claimPublication'
  | 'actionItem'
  | 'detailPayload'
  | 'client'
  | 'itemReplyDrafts'
  | 'captureTaskListRefresh'
  | 'setActionItem'
  | 'setDetailPayload'
  | 'setError'
  | 'setItemReplyDrafts'
  | 'setItems'
  | 'tryBeginMutation'
  | 'taskUiReady'
>

export function useMobileTasksGithubReplyMergeActions<
  Model extends useMobileTasksGithubReplyMergeActionsInput
>(model: Model) {
  const {
    claimPublication,
    client,
    itemReplyDrafts,
    captureTaskListRefresh,
    setActionItem,
    setDetailPayload,
    setError,
    setItemReplyDrafts,
    setItems,
    tryBeginMutation,
    taskUiReady
  } = model
  const replyToGitHubComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client) {
        return
      }
      const key = String(comment.id)
      const body = (itemReplyDrafts[key] ?? '').trim()
      if (!body) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const reviewAnchor =
          item.source.type === 'pr' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
            ? { path: comment.path, line: comment.line, commentId: comment.id }
            : null
        const replyResult = reviewAnchor
          ? githubReviewCommentReplyWrite.interpret(
              await githubReviewCommentReplyWrite.request(
                client,
                {
                  repo: `id:${item.source.repoId}`,
                  prNumber: item.source.number,
                  prRepo: requireGitHubTaskTarget(item.source).repository,
                  commentId: reviewAnchor.commentId,
                  body,
                  threadId: comment.threadId,
                  path: reviewAnchor.path,
                  line: reviewAnchor.line
                },
                { timeoutMs: 30_000 }
              )
            )
          : githubIssueCommentWrite.interpret(
              await githubIssueCommentWrite.request(
                client,
                {
                  repo: `id:${item.source.repoId}`,
                  number: item.source.number,
                  body: `@${commentAuthor(comment)} ${body}`,
                  type: item.source.type,
                  prRepo: requireGitHubTaskTarget(item.source).repository
                },
                { timeoutMs: 30_000 }
              )
            )
        if (replyResult.ok === false) {
          throw new Error(replyResult.error ?? 'Failed to reply')
        }
        if (!isCurrent()) {
          return
        }
        const reply: DetailComment = replyResult.comment ?? {
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
        setDetailPayload((current) =>
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
            ? { ...current, comments: [...current.comments, reply] }
            : current
        )
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to reply')
      } finally {
        finish()
      }
    },
    [claimPublication, client, itemReplyDrafts, tryBeginMutation]
  )

  const mergeHostedReview = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>,
      method: HostedReviewMergeMethod
    ): Promise<void> => {
      if (!client) {
        return
      }
      if (item.provider === 'github' && item.source.type !== 'pr') {
        return
      }
      if (item.provider === 'gitlab' && item.source.type !== 'mr') {
        return
      }
      if (item.provider === 'github' && isGitHubPrMergeBlocked(item)) {
        setError('GitHub reports merge conflicts. Open in GitHub to continue.')
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      const refreshList = captureTaskListRefresh()
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const merged =
          item.provider === 'github'
            ? githubPullRequestMerge.interpret(
                await githubPullRequestMerge.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    prNumber: item.source.number,
                    prRepo: requireGitHubTaskTarget(item.source).repository,
                    method
                  },
                  { timeoutMs: 60_000 }
                )
              )
            : gitlabMergeRequestMerge.interpret(
                await gitlabMergeRequestMerge.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    iid: item.source.number,
                    method,
                    projectRef: item.source.projectRef
                  },
                  { timeoutMs: 60_000 }
                )
              )
        if (merged.ok === false) {
          throw new Error(merged.error ?? 'Failed to merge')
        }
        refreshList()
        if (!isCurrent()) {
          return
        }
        setActionItem(null)
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to merge')
      } finally {
        finish()
      }
    },
    [claimPublication, client, captureTaskListRefresh, tryBeginMutation]
  )

  const setLinearStatus = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'linear' }>,
      state: LinearState,
      options: { closeDetail?: boolean } = {}
    ): Promise<void> => {
      if (!client || !taskUiReady) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      const refreshList = captureTaskListRefresh()
      setError('')
      try {
        const reply = await linearIssueUpdate.request(client, {
          id: item.source.id,
          workspaceId: item.source.workspaceId,
          updates: { stateId: state.id }
        })
        linearIssueUpdate.interpret(reply)
        const nextState = {
          name: state.name,
          type: state.type,
          color: state.color ?? item.source.state.color
        }
        setItems((current) =>
          current.map((entry) =>
            entry.provider === 'linear' && entry.source.id === item.source.id
              ? createLinearTask({ ...entry.source, state: nextState })
              : entry
          )
        )
        setActionItem((current) => {
          if (!current || current.provider !== 'linear' || current.source.id !== item.source.id) {
            return current
          }
          if (options.closeDetail !== false) {
            return null
          }
          return createLinearTask({
            ...current.source,
            state: nextState
          }) as Extract<TaskItem, { provider: 'linear' }>
        })
        refreshList()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Linear issue')
      } finally {
        finish()
      }
    },
    [claimPublication, client, captureTaskListRefresh, tryBeginMutation, taskUiReady]
  )
  return Object.assign(model, { replyToGitHubComment, mergeHostedReview, setLinearStatus })
}

export type GithubReplyMergeActionsModel = GithubCheckFileActionsModel &
  ReturnType<typeof useMobileTasksGithubReplyMergeActions>
