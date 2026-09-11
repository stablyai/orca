import type { HostedCommentReviewActionsModel } from './use-mobile-tasks-hosted-comment-review-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type DetailPayload,
  type GitHubDetailFile,
  type GitHubPRFileContents,
  type TaskItem,
  isSuccess
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksGithubCheckFileActions(model: HostedCommentReviewActionsModel) {
  const {
    client,
    detailPayload,
    expandedPrFilePath,
    mutatingStatus,
    prFileCommentDrafts,
    prFileContents,
    setDetailPayload,
    setDetailRefreshSeq,
    setError,
    setExpandedPrFilePath,
    setMutatingStatus,
    setPrFileCommentDrafts,
    setPrFileContents,
    setPrFileLoadingPath
  } = model
  const rerunGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, failedOnly: boolean): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.rerunPRChecks',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            failedOnly
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to rerun checks')
        }
        setDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus]
  )

  const toggleGitHubFileViewed = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: NonNullable<Extract<DetailPayload, { provider: 'github' }>['files'][number]>
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      if (detailPayload?.provider !== 'github' || !detailPayload.pullRequestId) {
        setError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.setPRFileViewed',
          {
            repo: `id:${item.source.repoId}`,
            pullRequestId: detailPayload.pullRequestId,
            path: file.path,
            viewed
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error('Failed to sync viewed state with GitHub.')
        }
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                files: current.files.map((candidate) =>
                  candidate.path === file.path
                    ? { ...candidate, viewerViewedState: viewed ? 'VIEWED' : 'UNVIEWED' }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update viewed state')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus]
  )

  const toggleGitHubReviewThread = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr' || !comment.threadId) {
        return
      }
      const resolve = !comment.isResolved
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.resolveReviewThread',
          {
            repo: `id:${item.source.repoId}`,
            threadId: comment.threadId,
            resolve
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
        }
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  candidate.threadId === comment.threadId
                    ? { ...candidate, isResolved: resolve }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update review thread')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, mutatingStatus]
  )

  const toggleGitHubFileExpansion = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile
    ): Promise<void> => {
      if (expandedPrFilePath === file.path) {
        setExpandedPrFilePath(null)
        return
      }
      setExpandedPrFilePath(file.path)
      if (prFileContents[file.path]) {
        return
      }
      if (
        !client ||
        item.source.type !== 'pr' ||
        detailPayload?.provider !== 'github' ||
        !detailPayload.headSha ||
        !detailPayload.baseSha
      ) {
        setError('Unable to load file contents for this pull request.')
        return
      }
      setPrFileLoadingPath(file.path)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.prFileContents',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: detailPayload.headSha,
            baseSha: detailPayload.baseSha
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        setPrFileContents((current) => ({
          ...current,
          [file.path]: response.result as GitHubPRFileContents
        }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file contents')
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [client, detailPayload, expandedPrFilePath, prFileContents]
  )

  const addGitHubFileReviewComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile,
      line: number
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      if (detailPayload?.provider !== 'github' || !detailPayload.headSha) {
        setError('Unable to comment without the PR head SHA.')
        return
      }
      const draftKey = `${file.path}:${line}`
      const body = (prFileCommentDrafts[draftKey] ?? '').trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.addPRReviewComment',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            commitId: detailPayload.headSha,
            path: file.path,
            line,
            body
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
          throw new Error(result.error ?? 'Failed to add review comment')
        }
        const comment: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          author: 'You',
          body,
          createdAt: new Date().toISOString(),
          path: file.path,
          line
        }
        setPrFileCommentDrafts((current) => {
          const next = { ...current }
          delete next[draftKey]
          return next
        })
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add review comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus, prFileCommentDrafts]
  )
  return Object.assign(model, {
    rerunGitHubChecks,
    toggleGitHubFileViewed,
    toggleGitHubReviewThread,
    toggleGitHubFileExpansion,
    addGitHubFileReviewComment
  })
}

export type GithubCheckFileActionsModel = ReturnType<typeof useMobileTasksGithubCheckFileActions>
