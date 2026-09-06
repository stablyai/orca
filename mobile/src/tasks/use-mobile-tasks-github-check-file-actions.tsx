import type { HostedCommentReviewActionsModel } from './use-mobile-tasks-hosted-comment-review-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type DetailPayload,
  type GitHubDetailFile,
  type TaskItem,
  taskItemMutationTarget
} from './mobile-tasks-model'

export function useMobileTasksGithubCheckFileActions(model: HostedCommentReviewActionsModel) {
  const {
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
    setPrFileLoadingPath,
    taskItemFileOperations,
    taskItemReviewOperations
  } = model
  const rerunGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, failedOnly: boolean): Promise<void> => {
      if (!taskItemFileOperations || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        await taskItemFileOperations.rerunChecks(
          taskItemMutationTarget(item),
          detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
          failedOnly
        )
        setDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setMutatingStatus(false)
      }
    },
    [detailPayload, mutatingStatus, taskItemFileOperations]
  )
  const toggleGitHubFileViewed = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: NonNullable<Extract<DetailPayload, { provider: 'github' }>['files'][number]>
    ): Promise<void> => {
      if (!taskItemFileOperations || mutatingStatus || item.source.type !== 'pr') {
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
        await taskItemFileOperations.setFileViewed(taskItemMutationTarget(item), {
          pullRequestId: detailPayload.pullRequestId,
          path: file.path,
          viewed
        })
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
    [detailPayload, mutatingStatus, taskItemFileOperations]
  )
  const toggleGitHubReviewThread = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (
        !taskItemReviewOperations ||
        mutatingStatus ||
        item.source.type !== 'pr' ||
        !comment.threadId
      ) {
        return
      }
      const resolve = !comment.isResolved
      setMutatingStatus(true)
      setError('')
      try {
        await taskItemReviewOperations.resolveThread(
          taskItemMutationTarget(item),
          comment.threadId,
          resolve
        )
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
    [mutatingStatus, taskItemReviewOperations]
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
        !taskItemFileOperations ||
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
        const contents = await taskItemFileOperations.loadFileContents(
          taskItemMutationTarget(item),
          {
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: detailPayload.headSha,
            baseSha: detailPayload.baseSha
          }
        )
        setPrFileContents((current) => ({ ...current, [file.path]: contents }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file contents')
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [detailPayload, expandedPrFilePath, prFileContents, taskItemFileOperations]
  )
  const addGitHubFileReviewComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile,
      line: number
    ): Promise<void> => {
      if (!taskItemFileOperations || mutatingStatus || item.source.type !== 'pr') {
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
        const comment: DetailComment = (await taskItemFileOperations.addInlineComment(
          taskItemMutationTarget(item),
          {
            commitId: detailPayload.headSha,
            path: file.path,
            line,
            body
          }
        )) ?? {
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
    [detailPayload, mutatingStatus, prFileCommentDrafts, taskItemFileOperations]
  )
  return Object.assign(model, {
    addGitHubFileReviewComment,
    rerunGitHubChecks,
    toggleGitHubFileExpansion,
    toggleGitHubFileViewed,
    toggleGitHubReviewThread
  })
}

export type GithubCheckFileActionsModel = ReturnType<typeof useMobileTasksGithubCheckFileActions>
