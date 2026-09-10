import type { HostedCommentReviewActionsModel } from './use-mobile-tasks-hosted-comment-review-actions'
import { useCallback } from './mobile-tasks-dependencies'
import type {
  DetailComment,
  DetailPayload,
  GitHubDetailFile,
  TaskItem
} from './mobile-tasks-legacy-foundation'
import { taskItemMutationTarget } from './mobile-tasks-mutation-targets'

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
    taskOperations
  } = model
  const rerunGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, failedOnly: boolean): Promise<void> => {
      if (!taskOperations || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        await taskOperations.itemFile.rerunChecks(
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
    [detailPayload, mutatingStatus, taskOperations]
  )

  const toggleGitHubFileViewed = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: NonNullable<Extract<DetailPayload, { provider: 'github' }>['files'][number]>
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus || item.source.type !== 'pr') {
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
        await taskOperations.itemFile.setFileViewed(taskItemMutationTarget(item), {
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
    [detailPayload, mutatingStatus, taskOperations]
  )

  const toggleGitHubReviewThread = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus || item.source.type !== 'pr' || !comment.threadId) {
        return
      }
      const resolve = !comment.isResolved
      setMutatingStatus(true)
      setError('')
      try {
        await taskOperations.itemReview.resolveThread(
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
    [mutatingStatus, taskOperations]
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
        !taskOperations ||
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
        const contents = await taskOperations.itemFile.loadFileContents(
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
    [detailPayload, expandedPrFilePath, prFileContents, taskOperations]
  )

  const addGitHubFileReviewComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile,
      line: number
    ): Promise<void> => {
      if (!taskOperations || mutatingStatus || item.source.type !== 'pr') {
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
        const comment: DetailComment = (await taskOperations.itemFile.addInlineComment(
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
    [detailPayload, mutatingStatus, prFileCommentDrafts, taskOperations]
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
