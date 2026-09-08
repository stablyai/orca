import type { HostedMetadataActionsModel } from './use-mobile-tasks-hosted-metadata-actions'
import { buildGitHubCheckSummary, useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubAssignableUser,
  type TaskItem,
  splitReviewerList,
  taskItemMutationTarget
} from './mobile-tasks-model'

export function useMobileTasksHostedCommentReviewActions(model: HostedMetadataActionsModel) {
  const {
    detailPayload,
    itemCommentDraft,
    itemReviewersDraft,
    mutatingStatus,
    setActionItem,
    setDetailPayload,
    setError,
    setItemCommentDraft,
    setItemReviewersDraft,
    setItems,
    setMutatingStatus,
    taskItemFileOperations,
    taskItemReviewOperations
  } = model
  const addHostedItemComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
    ): Promise<void> => {
      if (!taskItemReviewOperations || mutatingStatus) {
        return
      }
      const body = itemCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const addedComment = await taskItemReviewOperations.addComment(
          taskItemMutationTarget(item),
          body
        )
        const comment: DetailComment = addedComment ?? {
          id: `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: 'You'
        }
        setItemCommentDraft('')
        setDetailPayload((current) =>
          current &&
          ((item.provider === 'github' && current.provider === 'github') ||
            (item.provider === 'gitlab' && current.provider === 'gitlab'))
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [itemCommentDraft, mutatingStatus, taskItemReviewOperations]
  )
  const requestGitHubReviewers = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, logins?: string[]): Promise<void> => {
      if (!taskItemReviewOperations || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      const reviewers = logins ?? splitReviewerList(itemReviewersDraft)
      if (reviewers.length === 0) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        await taskItemReviewOperations.requestReviewers(taskItemMutationTarget(item), reviewers)
        const nextReviewRequests = (() => {
          const byLogin = new Map<string, GitHubAssignableUser>()
          for (const reviewer of detailPayload?.provider === 'github'
            ? detailPayload.reviewRequests
            : (item.source.reviewRequests ?? [])) {
            const login = reviewer.login.trim()
            if (login) {
              byLogin.set(login.toLowerCase(), reviewer)
            }
          }
          for (const login of reviewers) {
            const normalized = login.trim().replace(/^@/, '')
            if (normalized && !byLogin.has(normalized.toLowerCase())) {
              byLogin.set(normalized.toLowerCase(), {
                login: normalized,
                name: null,
                avatarUrl: null
              })
            }
          }
          return Array.from(byLogin.values())
        })()
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                source: { ...current.source, reviewRequests: nextReviewRequests }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  source: { ...candidate.source, reviewRequests: nextReviewRequests }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? { ...current, reviewRequests: nextReviewRequests }
            : current
        )
        if (!logins) {
          setItemReviewersDraft('')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to request reviewers')
      } finally {
        setMutatingStatus(false)
      }
    },
    [detailPayload, itemReviewersDraft, mutatingStatus, taskItemReviewOperations]
  )
  const refreshGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!taskItemFileOperations || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const checks = await taskItemFileOperations.refreshChecks(
          taskItemMutationTarget(item),
          detailPayload?.provider === 'github' ? detailPayload.headSha : undefined
        )
        const checksSummary = buildGitHubCheckSummary(checks)
        setDetailPayload((current) =>
          current?.provider === 'github' ? { ...current, checks } : current
        )
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                source: { ...current.source, checksSummary }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  source: { ...candidate.source, checksSummary }
                }
              : candidate
          )
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        setMutatingStatus(false)
      }
    },
    [detailPayload, mutatingStatus, taskItemFileOperations]
  )
  return Object.assign(model, {
    addHostedItemComment,
    refreshGitHubChecks,
    requestGitHubReviewers
  })
}

export type HostedCommentReviewActionsModel = ReturnType<
  typeof useMobileTasksHostedCommentReviewActions
>
