import type { GithubReplyMergeActionsModel } from './use-mobile-tasks-github-reply-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type LinearIssueChild,
  type TaskItem,
  createLinearTask
} from './mobile-tasks-legacy-foundation'
import { taskLinearTarget } from './mobile-tasks-mutation-targets'

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
    taskOperations
  } = model
  const addLinearComment = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
        return
      }
      const body = linearCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const commentId = await taskOperations.linear.addComment(taskLinearTarget(item), body)
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
    [linearCommentDraft, mutatingStatus, taskOperations]
  )

  const openLinearSubIssue = useCallback(
    async (child: LinearIssueChild, workspaceId?: string): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const issue = await taskOperations.linear.loadIssue({
          issueId: child.id,
          workspaceId,
          teamId: ''
        })
        setActionItem(createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [mutatingStatus, taskOperations]
  )

  const createLinearSubIssue = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!taskOperations || mutatingStatus) {
        return
      }
      const title = linearSubIssueTitle.trim()
      if (!title) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const result = await taskOperations.linear.createSubIssue(taskLinearTarget(item), title)
        const child: LinearIssueChild = {
          id: result.id,
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
    [linearSubIssueTitle, mutatingStatus, taskOperations]
  )
  return Object.assign(model, { addLinearComment, openLinearSubIssue, createLinearSubIssue })
}

export type LinearItemActionsModel = ReturnType<typeof useMobileTasksLinearItemActions>
