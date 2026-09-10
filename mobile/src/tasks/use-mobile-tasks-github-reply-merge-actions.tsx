import type { GithubCheckFileActionsModel } from './use-mobile-tasks-github-check-file-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type HostedReviewMergeMethod,
  type LinearState,
  type TaskItem,
  commentAuthor,
  createLinearTask,
  isGitHubPrMergeBlocked
} from './mobile-tasks-legacy-foundation'
import { taskItemMutationTarget, taskLinearTarget } from './mobile-tasks-mutation-targets'

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
    taskOperations,
    taskUiReady
  } = model
  const replyToGitHubComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
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
          ? taskOperations.itemReview.replyReviewComment(taskItemMutationTarget(item), {
              commentId: comment.id as number,
              body,
              ...(comment.threadId ? { threadId: comment.threadId } : {}),
              path: comment.path as string,
              line: comment.line as number
            })
          : taskOperations.itemReview.addComment(
              taskItemMutationTarget(item),
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
    [itemReplyDrafts, mutatingStatus, taskOperations]
  )

  const mergeHostedReview = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>,
      method: HostedReviewMergeMethod
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
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
        await taskOperations.itemReview.merge(taskItemMutationTarget(item), method)
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to merge')
      } finally {
        setMutatingStatus(false)
      }
    },
    [loadTasks, mutatingStatus, taskOperations]
  )

  const setLinearStatus = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'linear' }>,
      state: LinearState,
      options: { closeDetail?: boolean } = {}
    ): Promise<void> => {
      if (!taskOperations || !taskUiReady || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        await taskOperations.linear.updateState(taskLinearTarget(item), state.id)
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
    [loadTasks, mutatingStatus, taskOperations, taskUiReady]
  )
  return Object.assign(model, { replyToGitHubComment, mergeHostedReview, setLinearStatus })
}

export type GithubReplyMergeActionsModel = ReturnType<typeof useMobileTasksGithubReplyMergeActions>
