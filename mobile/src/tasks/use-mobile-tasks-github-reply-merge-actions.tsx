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
  taskItemMutationTarget,
  taskLinearTarget
} from './mobile-tasks-model'

export function useMobileTasksGithubReplyMergeActions(model: GithubCheckFileActionsModel) {
  const {
    itemReplyDrafts,
    loadTasks,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setItemReplyDrafts,
    setItems,
    setMutatingStatus,
    taskItemReviewOperations,
    taskLinearOperations,
    taskUiReady
  } = model
  const replyToGitHubComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!taskItemReviewOperations || mutatingStatus) {
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
        const posted = await (canUseReviewReply
          ? taskItemReviewOperations.replyReviewComment(taskItemMutationTarget(item), {
              commentId: comment.id as number,
              body,
              ...(comment.threadId ? { threadId: comment.threadId } : {}),
              path: comment.path as string,
              line: comment.line as number
            })
          : taskItemReviewOperations.addComment(
              taskItemMutationTarget(item),
              `@${commentAuthor(comment)} ${body}`
            ))
        // Why: only the server entry carries the numeric id a follow-up reply needs to stay on
        // this thread; the stub is the fallback for hosts that publish no comment.
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
    [itemReplyDrafts, mutatingStatus, taskItemReviewOperations]
  )
  const mergeHostedReview = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>,
      method: HostedReviewMergeMethod
    ): Promise<void> => {
      if (!taskItemReviewOperations || mutatingStatus) {
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
        await taskItemReviewOperations.merge(taskItemMutationTarget(item), method)
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to merge')
      } finally {
        setMutatingStatus(false)
      }
    },
    [loadTasks, mutatingStatus, taskItemReviewOperations]
  )
  const setLinearStatus = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'linear' }>,
      state: LinearState,
      options: { closeDetail?: boolean } = {}
    ): Promise<void> => {
      if (!taskLinearOperations || !taskUiReady || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        await taskLinearOperations.updateState(taskLinearTarget(item), state.id)
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
    [loadTasks, mutatingStatus, taskLinearOperations, taskUiReady]
  )
  return Object.assign(model, {
    mergeHostedReview,
    replyToGitHubComment,
    setLinearStatus
  })
}

export type GithubReplyMergeActionsModel = ReturnType<typeof useMobileTasksGithubReplyMergeActions>
