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

export function useMobileTasksGithubReplyMergeActions(model: GithubCheckFileActionsModel) {
  const {
    client,
    itemReplyDrafts,
    loadTasks,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setItemReplyDrafts,
    setItems,
    setMutatingStatus,
    taskUiReady
  } = model
  const replyToGitHubComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const key = String(comment.id)
      const body = (itemReplyDrafts[key] ?? '').trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        // The same predicate as before, but as the anchor it selects: `commentId` and `line` are
        // numbers only inside it, which the boolean it used to be could not carry to the send.
        const reviewAnchor =
          item.source.type === 'pr' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
            ? { path: comment.path, line: comment.line, commentId: comment.id }
            : null
        // A review reply and a plain issue comment are different methods, so each arm sends its
        // own operation rather than one call picking a method string.
        const replyResult = reviewAnchor
          ? githubReviewCommentReplyWrite.interpret(
              await githubReviewCommentReplyWrite.request(
                client,
                {
                  repo: `id:${item.source.repoId}`,
                  prNumber: item.source.number,
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
                  type: item.source.type
                },
                { timeoutMs: 30_000 }
              )
            )
        const envelope = replyResult
        if (envelope.ok === false) {
          throw new Error(envelope.error ?? 'Failed to reply')
        }
        const reply: DetailComment = envelope.comment ?? {
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
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, reply] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reply')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, itemReplyDrafts, mutatingStatus]
  )

  const mergeHostedReview = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>,
      method: HostedReviewMergeMethod
    ): Promise<void> => {
      if (!client || mutatingStatus) {
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
      setMutatingStatus(true)
      setError('')
      try {
        const merged =
          item.provider === 'github'
            ? githubPullRequestMerge.interpret(
                await githubPullRequestMerge.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    prNumber: item.source.number,
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
        const result = merged
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to merge')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to merge')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )

  const setLinearStatus = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'linear' }>,
      state: LinearState,
      options: { closeDetail?: boolean } = {}
    ): Promise<void> => {
      if (!client || !taskUiReady || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
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
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Linear issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus, taskUiReady]
  )
  return Object.assign(model, { replyToGitHubComment, mergeHostedReview, setLinearStatus })
}

export type GithubReplyMergeActionsModel = ReturnType<typeof useMobileTasksGithubReplyMergeActions>
