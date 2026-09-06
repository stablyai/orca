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
  type GitHubDetailCheck,
  type TaskItem,
  isSuccess,
  splitReviewerList
} from './mobile-tasks-legacy-foundation'

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
        const response =
          item.provider === 'github'
            ? await client.sendRequest(
                'github.addIssueComment',
                {
                  repo: `id:${item.source.repoId}`,
                  number: item.source.number,
                  body,
                  type: item.source.type
                },
                { timeoutMs: 30_000 }
              )
            : await client.sendRequest(
                item.source.type === 'mr' ? 'gitlab.addMRComment' : 'gitlab.addIssueComment',
                item.source.type === 'mr'
                  ? {
                      repo: `id:${item.source.repoId}`,
                      iid: item.source.number,
                      body,
                      projectRef: item.source.projectRef
                    }
                  : {
                      repo: `id:${item.source.repoId}`,
                      number: item.source.number,
                      body,
                      projectRef: item.source.projectRef
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
          throw new Error(result.error ?? 'Failed to add comment')
        }
        const comment: DetailComment = result.comment ?? {
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
        const response = await client.sendRequest(
          'github.requestPRReviewers',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            reviewers
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
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
        const response = await client.sendRequest(
          'github.prChecks',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (!Array.isArray(response.result)) {
          throw new Error('Invalid checks response')
        }
        const checks = response.result as GitHubDetailCheck[]
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
