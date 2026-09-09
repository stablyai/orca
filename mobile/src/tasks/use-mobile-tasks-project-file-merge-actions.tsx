import type { ProjectReviewCheckActionsModel } from './use-mobile-tasks-project-review-check-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubDetailFile,
  type GitHubPRFileContents,
  type GitHubProjectRow,
  type HostedReviewMergeMethod,
  type TaskItem,
  isSuccess,
  projectRowGitHubRepository
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectFileMergeActions(model: ProjectReviewCheckActionsModel) {
  const {
    activeGitHubProjectHost,
    client,
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
    setProjectRowItem
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
      if (
        !client ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number ||
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
        const response = await client.sendRequest(
          'github.prFileContents',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: projectRowDetail.headSha,
            baseSha: projectRowDetail.baseSha
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
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to load file contents'
        )
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [
      activeGitHubProjectHost,
      client,
      expandedPrFilePath,
      findProjectRowRepo,
      prFileContents,
      projectRowDetail
    ]
  )

  const addProjectGitHubFileReviewComment = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile, line: number): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
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
        const response = await client.sendRequest(
          'github.addPRReviewComment',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            commitId: projectRowDetail.headSha,
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
      client,
      findProjectRowRepo,
      prFileCommentDrafts,
      projectMutating,
      projectRowDetail
    ]
  )

  const mergeProjectGitHubPullRequest = useCallback(
    async (row: GitHubProjectRow, method: HostedReviewMergeMethod): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
      ) {
        return
      }
      if (row.content.state === 'CLOSED' || row.content.state === 'MERGED') {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.mergePR',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            method
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to merge pull request')
        }
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
    [activeGitHubProjectHost, client, findProjectRowRepo, projectMutating]
  )

  const toggleGitHubStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'open' : 'closed'
      try {
        const method = item.source.type === 'issue' ? 'github.updateIssue' : 'github.updatePRState'
        const params =
          item.source.type === 'issue'
            ? {
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                updates: { state: nextState }
              }
            : {
                repo: `id:${item.source.repoId}`,
                prNumber: item.source.number,
                updates: { state: nextState }
              }
        const response = await client.sendRequest(method, params)
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub status')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update status')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )
  return Object.assign(model, {
    toggleProjectGitHubFileExpansion,
    addProjectGitHubFileReviewComment,
    mergeProjectGitHubPullRequest,
    toggleGitHubStatus
  })
}

export type ProjectFileMergeActionsModel = ReturnType<typeof useMobileTasksProjectFileMergeActions>
