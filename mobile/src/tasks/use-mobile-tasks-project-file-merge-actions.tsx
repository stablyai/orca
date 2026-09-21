import type { ProjectReviewCheckActionsModel } from './use-mobile-tasks-project-review-check-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type DetailComment,
  type GitHubDetailFile,
  type GitHubProjectRow,
  type HostedReviewMergeMethod,
  type TaskItem,
  projectRowGitHubRepository
} from './mobile-tasks-legacy-foundation'
import {
  githubIssueUpdate,
  githubPullRequestFileContentsRead,
  githubPullRequestMerge,
  githubPullRequestStateUpdate
} from './mobile-task-item-state-operations'
import { githubReviewCommentWrite } from './mobile-task-item-comment-operations'

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
        const reply = await githubPullRequestFileContentsRead.request(
          client,
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
        const contents = githubPullRequestFileContentsRead.interpret(reply)
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
        const reply = await githubReviewCommentWrite.request(
          client,
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
        const result = githubReviewCommentWrite.interpret(reply)
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
        const reply = await githubPullRequestMerge.request(
          client,
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            method
          },
          { timeoutMs: 60_000 }
        )
        const result = githubPullRequestMerge.interpret(reply)
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
        // The method and its params were a pair of local ternaries over the item type, not a step
        // handed in at runtime, so each arm sends its own operation with its own params type.
        const updated =
          item.source.type === 'issue'
            ? githubIssueUpdate.interpret(
                await githubIssueUpdate.request(client, {
                  repo: `id:${item.source.repoId}`,
                  number: item.source.number,
                  updates: { state: nextState }
                })
              )
            : githubPullRequestStateUpdate.interpret(
                await githubPullRequestStateUpdate.request(client, {
                  repo: `id:${item.source.repoId}`,
                  prNumber: item.source.number,
                  updates: { state: nextState }
                })
              )
        if (updated.ok === false) {
          throw new Error(updated.error ?? 'Failed to update GitHub status')
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
