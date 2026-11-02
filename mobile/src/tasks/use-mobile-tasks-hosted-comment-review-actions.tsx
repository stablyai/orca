import { githubTaskKey, sameGitHubTask, requireGitHubTaskTarget } from './github-task-identity'
import { useClipboardWriter } from '../platform/clipboard'
import type { HostedMetadataActionsModel } from './use-mobile-tasks-hosted-metadata-actions'
import {
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

export type HostedCommentReviewActionsInput = Pick<
  HostedMetadataActionsModel,
  | 'claimPublication'
  | 'client'
  | 'copiedLinkResetTimerRef'
  | 'detailPayload'
  | 'itemCommentDraft'
  | 'itemReviewersDraft'
  | 'tryBeginMutation'
  | 'setActionItem'
  | 'setCopiedLinkKey'
  | 'setDetailPayload'
  | 'setError'
  | 'setItemCommentDraft'
  | 'setItemReviewersDraft'
  | 'setItems'
>

export function useMobileTasksHostedCommentReviewActions<
  Model extends HostedCommentReviewActionsInput
>(model: Model) {
  // Use the native clipboard seam; iOS custom-scheme pages lack the secure context required by web clipboard APIs.
  const clipboard = useClipboardWriter()
  const {
    claimPublication,
    client,
    copiedLinkResetTimerRef,
    detailPayload,
    itemCommentDraft,
    itemReviewersDraft,
    tryBeginMutation,
    setActionItem,
    setCopiedLinkKey,
    setDetailPayload,
    setError,
    setItemCommentDraft,
    setItemReviewersDraft,
    setItems
  } = model
  const addHostedItemComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
    ): Promise<void> => {
      if (!client) {
        return
      }
      const body = itemCommentDraft.trim()
      if (!body) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const written =
          item.provider === 'github'
            ? githubIssueCommentWrite.interpret(
                await githubIssueCommentWrite.request(
                  client,
                  {
                    repo: `id:${item.source.repoId}`,
                    number: item.source.number,
                    body,
                    type: item.source.type,
                    prRepo: requireGitHubTaskTarget(item.source).repository
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
        if (!isCurrent()) {
          return
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
          ((item.provider === 'github' &&
            current.provider === 'github' &&
            current.targetKey === githubTaskKey(item.source)) ||
            (item.provider === 'gitlab' && current.provider === 'gitlab'))
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        finish()
      }
    },
    [claimPublication, client, itemCommentDraft, tryBeginMutation]
  )

  const copyTaskLink = useCallback(
    async (key: string, url: string): Promise<void> => {
      try {
        await clipboard.writeText(url)
        setCopiedLinkKey(key)
        scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to copy link')
      }
    },
    [clipboard]
  )

  const copyTextToClipboard = useCallback(
    async (key: string, value: string): Promise<void> => {
      try {
        await clipboard.writeText(value)
        setCopiedLinkKey(key)
        scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to copy text')
      }
    },
    [clipboard]
  )

  const requestGitHubReviewers = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, logins?: string[]): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      const reviewers = logins ?? splitReviewerList(itemReviewersDraft)
      if (reviewers.length === 0) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const reply = await githubReviewerRequest.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            reviewers
          },
          { timeoutMs: 30_000 }
        )
        const result = githubReviewerRequest.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to request reviewers')
        }
        if (!isCurrent()) {
          return
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
          sameGitHubTask(current, item)
            ? {
                ...current,
                source: { ...current.source, reviewRequests: nextReviewRequests }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            sameGitHubTask(candidate, item)
              ? {
                  ...candidate,
                  source: { ...candidate.source, reviewRequests: nextReviewRequests }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
            ? { ...current, reviewRequests: nextReviewRequests }
            : current
        )
        if (!logins) {
          setItemReviewersDraft('')
        }
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to request reviewers')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, itemReviewersDraft, tryBeginMutation]
  )

  const refreshGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item)
      try {
        const reply = await githubPullRequestChecksRead.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
        const checks = githubPullRequestChecksRead.interpret(reply)
        if (!isCurrent()) {
          return
        }
        const checksSummary = buildGitHubCheckSummary(checks)
        setDetailPayload((current) =>
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
            ? { ...current, checks }
            : current
        )
        setActionItem((current) =>
          sameGitHubTask(current, item)
            ? {
                ...current,
                source: { ...current.source, checksSummary }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            sameGitHubTask(candidate, item)
              ? {
                  ...candidate,
                  source: { ...candidate.source, checksSummary }
                }
              : candidate
          )
        )
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, tryBeginMutation]
  )
  return Object.assign(model, {
    addHostedItemComment,
    copyTaskLink,
    copyTextToClipboard,
    requestGitHubReviewers,
    refreshGitHubChecks
  })
}

export type HostedCommentReviewActionsModel = HostedMetadataActionsModel &
  ReturnType<typeof useMobileTasksHostedCommentReviewActions>
