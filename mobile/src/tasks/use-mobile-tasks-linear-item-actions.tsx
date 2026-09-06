import type { GithubReplyMergeActionsModel } from './use-mobile-tasks-github-reply-merge-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type LinearIssue,
  type LinearIssueChild,
  type TaskItem,
  createLinearTask,
  isSuccess
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksLinearItemActions(model: GithubReplyMergeActionsModel) {
  const {
    client,
    linearCommentDraft,
    linearSubIssueTitle,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setLinearCommentDraft,
    setLinearSubIssueTitle,
    setMutatingStatus
  } = model
  const addLinearComment = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const body = linearCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.addIssueComment',
          {
            issueId: item.source.id,
            workspaceId: item.source.workspaceId,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; id?: string; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add comment')
        }
        const comment: DetailComment = {
          id: result.id ?? `local-${Date.now()}`,
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
    [client, linearCommentDraft, mutatingStatus]
  )

  const openLinearSubIssue = useCallback(
    async (child: LinearIssueChild, workspaceId?: string): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.getIssue',
          { id: child.id, workspaceId },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const issue = response.result as LinearIssue | null
        if (!issue) {
          throw new Error('Sub-issue not found')
        }
        setActionItem(createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, mutatingStatus]
  )

  const createLinearSubIssue = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const title = linearSubIssueTitle.trim()
      if (!title) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.createIssue',
          {
            teamId: item.source.team.id,
            title,
            workspaceId: item.source.workspaceId,
            parentIssueId: item.source.id,
            projectId: item.source.project?.id ?? null
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          id?: string
          identifier?: string
          title?: string
          url?: string
          error?: string
        }
        if (result.ok === false || !result.id || !result.identifier) {
          throw new Error(result.error ?? 'Failed to create sub-issue')
        }
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
    [client, linearSubIssueTitle, mutatingStatus]
  )
  return Object.assign(model, { addLinearComment, openLinearSubIssue, createLinearSubIssue })
}

export type LinearItemActionsModel = ReturnType<typeof useMobileTasksLinearItemActions>
