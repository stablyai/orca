import type { HostedMetadataActionsModel } from './use-mobile-tasks-hosted-metadata-actions'
import {
  Clipboard,
  buildGitHubCheckSummary,
  scheduleMobileTaskCopyFeedbackReset,
  useCallback
} from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubAssignableUser,
  type TaskItem,
  splitReviewerList
} from './mobile-tasks-legacy-foundation'
import {
  githubIssueCommentWrite,
  gitlabIssueCommentWrite,
  gitlabMergeRequestCommentWrite
} from './mobile-task-item-comment-operations'
import {
  githubPullRequestChecksRead,
  githubReviewerRequest
} from './mobile-task-item-state-operations'

export function useMobileTasksHostedCommentReviewActions(model: HostedMetadataActionsModel) {
  const {
    client,
    copiedLinkResetTimerRef,
    detailPayload,
    itemCommentDraft,
    itemReviewersDraft,
    mutatingStatus,
    setActionItem,
    setCopiedLinkKey,
    setDetailPayload,
    setError,
    setItemCommentDraft,
    setItemReviewersDraft,
    setItems,
    setMutatingStatus
  } = model
  const addHostedItemComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const body = itemCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        // Three methods, one per provider and item type. Each arm sends its own operation rather
        // than one call picking a method string and a matching params shape.
        const written =
          item.provider === 'github'
            ? githubIssueCommentWrite.interpret(
                await githubIssueCommentWrite.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    number: item.source.number,
                    body,
                    type: item.source.type
                  },
                  { timeoutMs: 30_000 }
                )
              )
            : item.source.type === 'mr'
              ? gitlabMergeRequestCommentWrite.interpret(
                  await gitlabMergeRequestCommentWrite.request(
                    client,
                    {
                      repo: `id:${item.source.repoId}`,
                      iid: item.source.number,
                      body,
                      projectRef: item.source.projectRef
                    },
                    { timeoutMs: 30_000 }
                  )
                )
              : gitlabIssueCommentWrite.interpret(
                  await gitlabIssueCommentWrite.request(
                    client,
                    {
                      repo: `id:${item.source.repoId}`,
                      number: item.source.number,
                      body,
                      projectRef: item.source.projectRef
                    },
                    { timeoutMs: 30_000 }
                  )
                )
        if (written.ok === false) {
          throw new Error(written.error ?? 'Failed to add comment')
        }
        const comment: DetailComment = written.comment ?? {
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
    [client, itemCommentDraft, mutatingStatus]
  )

  const copyTaskLink = useCallback(async (key: string, url: string): Promise<void> => {
    try {
      await Clipboard.setStringAsync(url)
      setCopiedLinkKey(key)
      scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy link')
    }
  }, [])

  const copyTextToClipboard = useCallback(async (key: string, value: string): Promise<void> => {
    try {
      await Clipboard.setStringAsync(value)
      setCopiedLinkKey(key)
      scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy text')
    }
  }, [])

  const requestGitHubReviewers = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, logins?: string[]): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      const reviewers = logins ?? splitReviewerList(itemReviewersDraft)
      if (reviewers.length === 0) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const reply = await githubReviewerRequest.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            reviewers
          },
          { timeoutMs: 30_000 }
        )
        const result = githubReviewerRequest.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to request reviewers')
        }
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
    [client, detailPayload, itemReviewersDraft, mutatingStatus]
  )

  const refreshGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const reply = await githubPullRequestChecksRead.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
        // The reader answers an array of readable rows, so the hand-rolled shape test this call
        // site kept is gone: a reply that is not one now names the method it came from.
        const checks = githubPullRequestChecksRead.interpret(reply)
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
    [client, detailPayload, mutatingStatus]
  )
  return Object.assign(model, {
    addHostedItemComment,
    copyTaskLink,
    copyTextToClipboard,
    requestGitHubReviewers,
    refreshGitHubChecks
  })
}

export type HostedCommentReviewActionsModel = ReturnType<
  typeof useMobileTasksHostedCommentReviewActions
>
