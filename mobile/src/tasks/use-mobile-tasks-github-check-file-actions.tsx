import { githubTaskKey, requireGitHubTaskTarget } from './github-task-identity'
import type { HostedCommentReviewActionsModel } from './use-mobile-tasks-hosted-comment-review-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  githubPullRequestChecksRerun,
  githubPullRequestFileContentsRead,
  githubPullRequestFileViewedWrite
} from './mobile-task-item-state-operations'
import {
  githubReviewCommentWrite,
  githubReviewThreadResolve
} from './mobile-task-item-comment-operations'
import type {
  DetailComment,
  DetailPayload,
  GitHubDetailFile,
  TaskItem
} from './mobile-tasks-legacy-foundation'

export type useMobileTasksGithubCheckFileActionsInput = Pick<
  HostedCommentReviewActionsModel,
  | 'claimPublication'
  | 'actionItem'
  | 'detailPayload'
  | 'client'
  | 'expandedPrFilePath'
  | 'prFileCommentDrafts'
  | 'prFileContents'
  | 'setDetailPayload'
  | 'setDetailRefreshSeq'
  | 'setError'
  | 'setExpandedPrFilePath'
  | 'tryBeginMutation'
  | 'setPrFileCommentDrafts'
  | 'setPrFileContents'
  | 'beginFileLoad'
>

export function useMobileTasksGithubCheckFileActions<
  Model extends useMobileTasksGithubCheckFileActionsInput
>(model: Model) {
  const {
    claimPublication,
    client,
    detailPayload,
    expandedPrFilePath,
    prFileCommentDrafts,
    prFileContents,
    setDetailPayload,
    setDetailRefreshSeq,
    setError,
    setExpandedPrFilePath,
    tryBeginMutation,
    setPrFileCommentDrafts,
    setPrFileContents,
    beginFileLoad
  } = model
  const rerunGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, failedOnly: boolean): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item, detailPayload)
      try {
        const reply = await githubPullRequestChecksRerun.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            failedOnly
          },
          { timeoutMs: 60_000 }
        )
        const result = githubPullRequestChecksRerun.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to rerun checks')
        }
        if (!isCurrent()) {
          return
        }
        setDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, tryBeginMutation]
  )

  const toggleGitHubFileViewed = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: NonNullable<Extract<DetailPayload, { provider: 'github' }>['files'][number]>
    ): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      if (
        detailPayload?.provider !== 'github' ||
        detailPayload.targetKey !== githubTaskKey(item.source) ||
        !detailPayload.pullRequestId
      ) {
        setError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item, detailPayload)
      try {
        const reply = await githubPullRequestFileViewedWrite.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            pullRequestId: detailPayload.pullRequestId,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            path: file.path,
            viewed
          },
          { timeoutMs: 30_000 }
        )
        if (githubPullRequestFileViewedWrite.interpret(reply) !== true) {
          throw new Error('Failed to sync viewed state with GitHub.')
        }
        if (!isCurrent()) {
          return
        }
        setDetailPayload((current) =>
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
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
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to update viewed state')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, tryBeginMutation]
  )

  const toggleGitHubReviewThread = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client || item.source.type !== 'pr' || !comment.threadId) {
        return
      }
      const resolve = !comment.isResolved
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item, detailPayload)
      try {
        const reply = await githubReviewThreadResolve.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            threadId: comment.threadId,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            resolve
          },
          { timeoutMs: 30_000 }
        )
        if (githubReviewThreadResolve.interpret(reply) !== true) {
          throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
        }
        if (!isCurrent()) {
          return
        }
        setDetailPayload((current) =>
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
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
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to update review thread')
      } finally {
        finish()
      }
    },
    [claimPublication, client, tryBeginMutation]
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
        detailPayload.targetKey !== githubTaskKey(item.source) ||
        !detailPayload.headSha ||
        !detailPayload.baseSha
      ) {
        setError('Unable to load file contents for this pull request.')
        return
      }
      setError('')
      const request = beginFileLoad(file.path, claimPublication(item, detailPayload))
      const isCurrent = request.canPublish
      try {
        const reply = await githubPullRequestFileContentsRead.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: detailPayload.headSha,
            baseSha: detailPayload.baseSha
          },
          { timeoutMs: 30_000 }
        )
        const contents = githubPullRequestFileContentsRead.interpret(reply)
        if (!isCurrent()) {
          return
        }
        setPrFileContents((current) => ({ ...current, [file.path]: contents }))
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load file contents')
      } finally {
        request.finish()
      }
    },
    [beginFileLoad, claimPublication, client, detailPayload, expandedPrFilePath, prFileContents]
  )

  const addGitHubFileReviewComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile,
      line: number
    ): Promise<void> => {
      if (!client || item.source.type !== 'pr') {
        return
      }
      if (
        detailPayload?.provider !== 'github' ||
        detailPayload.targetKey !== githubTaskKey(item.source) ||
        !detailPayload.headSha
      ) {
        setError('Unable to comment without the PR head SHA.')
        return
      }
      const draftKey = `${file.path}:${line}`
      const body = (prFileCommentDrafts[draftKey] ?? '').trim()
      if (!body) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      const isCurrent = claimPublication(item, detailPayload)
      try {
        const reply = await githubReviewCommentWrite.request(
          client,
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            prRepo: requireGitHubTaskTarget(item.source).repository,
            commitId: detailPayload.headSha,
            path: file.path,
            line,
            body
          },
          { timeoutMs: 30_000 }
        )
        const result = githubReviewCommentWrite.interpret(reply)
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add review comment')
        }
        if (!isCurrent()) {
          return
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
          current?.provider === 'github' && current.targetKey === githubTaskKey(item.source)
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to add review comment')
      } finally {
        finish()
      }
    },
    [claimPublication, client, detailPayload, tryBeginMutation, prFileCommentDrafts]
  )
  return Object.assign(model, {
    rerunGitHubChecks,
    toggleGitHubFileViewed,
    toggleGitHubReviewThread,
    toggleGitHubFileExpansion,
    addGitHubFileReviewComment
  })
}

export type GithubCheckFileActionsModel = HostedCommentReviewActionsModel &
  ReturnType<typeof useMobileTasksGithubCheckFileActions>
