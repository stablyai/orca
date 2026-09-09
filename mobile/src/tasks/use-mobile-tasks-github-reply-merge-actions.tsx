import type { GithubCheckFileActionsModel } from './use-mobile-tasks-github-check-file-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type HostedReviewMergeMethod,
  type LinearState,
  type TaskItem,
  commentAuthor,
  createLinearTask,
  isGitHubPrMergeBlocked,
  isSuccess
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
        const canUseReviewReply =
          item.source.type === 'pr' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
        const response = canUseReviewReply
          ? await client.sendRequest(
              'github.addPRReviewCommentReply',
              {
                repo: `id:${item.source.repoId}`,
                prNumber: item.source.number,
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
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                body: `@${commentAuthor(comment)} ${body}`,
                type: item.source.type
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
        const response =
          item.provider === 'github'
            ? await client.sendRequest(
                'github.mergePR',
                {
                  repo: `id:${item.source.repoId}`,
                  prNumber: item.source.number,
                  method
                },
                { timeoutMs: 60_000 }
              )
            : await client.sendRequest(
                'gitlab.mergeMR',
                {
                  repo: `id:${item.source.repoId}`,
                  iid: item.source.number,
                  method,
                  projectRef: item.source.projectRef
                },
                { timeoutMs: 60_000 }
              )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
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
        const response = await client.sendRequest('linear.updateIssue', {
          id: item.source.id,
          workspaceId: item.source.workspaceId,
          updates: { stateId: state.id }
        })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
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
