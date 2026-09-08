import type { ProjectReviewCheckActionsModel } from './use-mobile-tasks-project-review-check-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubDetailFile,
  type GitHubProjectRow,
  type HostedReviewMergeMethod,
  type TaskItem,
  projectRowMutationTarget,
  taskItemMutationTarget
} from './mobile-tasks-model'

export function useMobileTasksProjectFileMergeActions(model: ProjectReviewCheckActionsModel) {
  const {
    activeGitHubProjectHost,
    expandedPrFilePath,
    findProjectRowRepo,
    loadTasks,
    mutatingStatus,
    prFileCommentDrafts,
    prFileContents,
    projectMutating,
    projectRowDetail,
    setActionItem,
    setError,
    setExpandedPrFilePath,
    setGithubProjectTable,
    setMutatingStatus,
    setPrFileCommentDrafts,
    setPrFileContents,
    setPrFileLoadingPath,
    setProjectMutating,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowItem,
    taskItemMutationOperations,
    taskProjectFileOperations,
    taskProjectMutationOperations
  } = model
  const toggleProjectGitHubFileExpansion = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile): Promise<void> => {
      if (expandedPrFilePath === file.path) {
        setExpandedPrFilePath(null)
        return
      }
      setExpandedPrFilePath(file.path)
      if (prFileContents[file.path]) {
        return
      }
      const repo = findProjectRowRepo(row)
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (
        !taskProjectFileOperations ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !target ||
        projectRowDetail?.provider !== 'github' ||
        !projectRowDetail.headSha ||
        !projectRowDetail.baseSha
      ) {
        setProjectRowDetailError('Unable to load file contents for this pull request.')
        return
      }
      setPrFileLoadingPath(file.path)
      setProjectRowDetailError('')
      try {
        const contents = await taskProjectFileOperations.loadFileContents(target, repo.id, {
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status ?? 'modified',
          headSha: projectRowDetail.headSha,
          baseSha: projectRowDetail.baseSha
        })
        setPrFileContents((current) => ({ ...current, [file.path]: contents }))
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to load file contents'
        )
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [
      activeGitHubProjectHost,
      expandedPrFilePath,
      findProjectRowRepo,
      prFileContents,
      projectRowDetail,
      taskProjectFileOperations
    ]
  )
  const addProjectGitHubFileReviewComment = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile, line: number): Promise<void> => {
      const repo = findProjectRowRepo(row)
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (
        !taskProjectFileOperations ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !target
      ) {
        return
      }
      if (projectRowDetail?.provider !== 'github' || !projectRowDetail.headSha) {
        setProjectRowDetailError('Unable to comment without the PR head SHA.')
        return
      }
      const draftKey = `${file.path}:${line}`
      const body = (prFileCommentDrafts[draftKey] ?? '').trim()
      if (!body) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const addedComment = await taskProjectFileOperations.addInlineComment(target, repo.id, {
          commitId: projectRowDetail.headSha,
          path: file.path,
          line,
          body
        })
        const comment: DetailComment = addedComment ?? {
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
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to add review comment'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [
      activeGitHubProjectHost,
      findProjectRowRepo,
      prFileCommentDrafts,
      projectMutating,
      projectRowDetail,
      taskProjectFileOperations
    ]
  )
  const mergeProjectGitHubPullRequest = useCallback(
    async (row: GitHubProjectRow, method: HostedReviewMergeMethod): Promise<void> => {
      const repo = findProjectRowRepo(row)
      const target = projectRowMutationTarget(row, activeGitHubProjectHost)
      if (
        !taskProjectMutationOperations ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !target
      ) {
        return
      }
      if (row.content.state === 'CLOSED' || row.content.state === 'MERGED') {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskProjectMutationOperations.merge(target, repo.id, method)
        setProjectRowItem((current) =>
          current?.id === row.id
            ? { ...current, content: { ...current.content, state: 'MERGED' } }
            : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, content: { ...candidate.content, state: 'MERGED' } }
                    : candidate
                )
              }
            : table
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to merge pull request'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, findProjectRowRepo, projectMutating, taskProjectMutationOperations]
  )
  const toggleGitHubStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!taskItemMutationOperations || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'open' : 'closed'
      try {
        await taskItemMutationOperations.setClosed(
          taskItemMutationTarget(item),
          nextState === 'closed'
        )
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update status')
      } finally {
        setMutatingStatus(false)
      }
    },
    [loadTasks, mutatingStatus, taskItemMutationOperations]
  )
  return Object.assign(model, {
    addProjectGitHubFileReviewComment,
    mergeProjectGitHubPullRequest,
    toggleGitHubStatus,
    toggleProjectGitHubFileExpansion
  })
}

export type ProjectFileMergeActionsModel = ReturnType<typeof useMobileTasksProjectFileMergeActions>
