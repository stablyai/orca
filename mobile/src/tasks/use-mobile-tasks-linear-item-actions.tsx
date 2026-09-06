import type { GithubReplyMergeActionsModel } from './use-mobile-tasks-github-reply-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type LinearIssueChild,
  type TaskItem,
  createLinearTask,
  taskLinearTarget
} from './mobile-tasks-model'

export function useMobileTasksLinearItemActions(model: GithubReplyMergeActionsModel) {
  const {
    linearCommentDraft,
    linearSubIssueTitle,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setLinearCommentDraft,
    setLinearSubIssueTitle,
    setMutatingStatus,
    taskLinearOperations
  } = model
  const addLinearComment = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!taskLinearOperations || mutatingStatus) {
        return
      }
      const body = linearCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const commentId = await taskLinearOperations.addComment(taskLinearTarget(item), body)
        const comment: DetailComment = {
          id: commentId ?? `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          user: { displayName: 'You' }
        }
        setLinearCommentDraft('')
        setDetailPayload((current) =>
          current?.provider === 'linear'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add Linear comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [linearCommentDraft, mutatingStatus, taskLinearOperations]
  )
  const openLinearSubIssue = useCallback(
    async (child: LinearIssueChild, workspaceId?: string): Promise<void> => {
      if (!taskLinearOperations || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const issue = await taskLinearOperations.loadIssue({
          issueId: child.id,
          workspaceId,
          teamId: '',
          targetId: child.targetId
        })
        setActionItem(createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [mutatingStatus, taskLinearOperations]
  )
  const createLinearSubIssue = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!taskLinearOperations || mutatingStatus) {
        return
      }
      const title = linearSubIssueTitle.trim()
      if (!title) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const result = await taskLinearOperations.createSubIssue(taskLinearTarget(item), title)
        const child: LinearIssueChild = {
          id: result.id,
          targetId: result.targetId,
          identifier: result.identifier,
          title: result.title ?? title,
          url: result.url ?? ''
        }
        setLinearSubIssueTitle('')
        setDetailPayload((current) =>
          current?.provider === 'linear'
            ? {
                ...current,
                children: current.children.some((entry) => entry.id === child.id)
                  ? current.children
                  : [...current.children, child]
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [linearSubIssueTitle, mutatingStatus, taskLinearOperations]
  )
  return Object.assign(model, {
    addLinearComment,
    createLinearSubIssue,
    openLinearSubIssue
  })
}

export type LinearItemActionsModel = ReturnType<typeof useMobileTasksLinearItemActions>
