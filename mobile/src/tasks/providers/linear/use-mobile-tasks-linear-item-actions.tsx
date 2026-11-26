import type { GithubReplyMergeActionsModel } from '../../item-detail/use-mobile-tasks-github-reply-merge-actions'
import { useCallback } from 'react'
import type { DetailComment, LinearIssueChild } from '../../mobile-tasks-provider-detail-types'
import type { TaskItem } from '../../mobile-tasks-project-workspace-types'
import { createLinearTask } from '../../item-detail/mobile-tasks-item-mapping'
import { linearIssueRead } from '../../item-detail/mobile-task-item-detail-operations'
import { linearIssueCommentWrite } from '../../item-detail/mobile-task-item-comment-operations'
import { linearIssueCreate } from '../../item-detail/mobile-task-item-state-operations'

export function useMobileTasksLinearItemActions<
  Model extends Pick<
    GithubReplyMergeActionsModel,
    | 'client'
    | 'linearCommentDraft'
    | 'linearSubIssueTitle'
    | 'tryBeginMutation'
    | 'setActionItem'
    | 'setDetailPayload'
    | 'setError'
    | 'setLinearCommentDraft'
    | 'setLinearSubIssueTitle'
  >
>(model: Model) {
  const {
    client,
    linearCommentDraft,
    linearSubIssueTitle,
    tryBeginMutation,
    setActionItem,
    setDetailPayload,
    setError,
    setLinearCommentDraft,
    setLinearSubIssueTitle
  } = model
  const addLinearComment = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client) {
        return
      }
      const body = linearCommentDraft.trim()
      if (!body) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      try {
        const reply = await linearIssueCommentWrite.request(
          client,
          {
            issueId: item.source.id,
            workspaceId: item.source.workspaceId,
            body
          },
          { timeoutMs: 30_000 }
        )
        const result = linearIssueCommentWrite.interpret(reply)
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
        finish()
      }
    },
    [client, linearCommentDraft, setLinearCommentDraft, tryBeginMutation]
  )

  const openLinearSubIssue = useCallback(
    async (child: LinearIssueChild, workspaceId?: string): Promise<void> => {
      if (!client) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      try {
        const reply = await linearIssueRead.request(
          client,
          { id: child.id, workspaceId },
          { timeoutMs: 30_000 }
        )
        const issue = linearIssueRead.interpret(reply)
        if (!issue) {
          throw new Error('Sub-issue not found')
        }
        setActionItem(createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Linear sub-issue')
      } finally {
        finish()
      }
    },
    [client, tryBeginMutation]
  )

  const createLinearSubIssue = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client) {
        return
      }
      const title = linearSubIssueTitle.trim()
      if (!title) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      try {
        const reply = await linearIssueCreate.request(
          client,
          {
            teamId: item.source.team.id,
            title,
            workspaceId: item.source.workspaceId,
            parentIssueId: item.source.id,
            projectId: item.source.project?.id ?? null
          },
          { timeoutMs: 30_000 }
        )
        const result = linearIssueCreate.interpret(reply)
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
        finish()
      }
    },
    [client, linearSubIssueTitle, tryBeginMutation]
  )
  return Object.assign(model, { addLinearComment, openLinearSubIssue, createLinearSubIssue })
}

export type LinearItemActionsModel = GithubReplyMergeActionsModel &
  ReturnType<typeof useMobileTasksLinearItemActions>
