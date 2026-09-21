import type { ProjectMetadataActionsModel } from './use-mobile-tasks-project-metadata-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type GitHubAssignableUser,
  type GitHubDetailCheck,
  type GitHubDetailFile,
  type GitHubProjectRow,
  isSuccess,
  projectRowGitHubRepository,
  splitReviewerList
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectReviewCheckActions(model: ProjectMetadataActionsModel) {
  const {
    activeGitHubProjectHost,
    client,
    findProjectRowRepo,
    projectMutating,
    projectReviewersDraft,
    projectRowDetail,
    setProjectMutating,
    setProjectReviewersDraft,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowDetailRefreshSeq
  } = model
  const requestProjectGitHubReviewers = useCallback(
    async (row: GitHubProjectRow, logins?: string[]): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || row.itemType !== 'PULL_REQUEST' || !repo) {
        return
      }
      const reviewers = logins ?? splitReviewerList(projectReviewersDraft)
      if (reviewers.length === 0 || !row.content.number) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.requestPRReviewers',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
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
          for (const reviewer of projectRowDetail?.provider === 'github'
            ? projectRowDetail.reviewRequests
            : []) {
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
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, reviewRequests: nextReviewRequests }
            : current
        )
        if (!logins) {
          setProjectReviewersDraft('')
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to request reviewers')
      } finally {
        setProjectMutating(false)
      }
    },
    [
      activeGitHubProjectHost,
      client,
      findProjectRowRepo,
      projectMutating,
      projectReviewersDraft,
      projectRowDetail
    ]
  )

  const refreshProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
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
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.prChecks',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            headSha: projectRowDetail?.provider === 'github' ? projectRowDetail.headSha : undefined,
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
        setProjectRowDetail((current) =>
          current?.provider === 'github' ? { ...current, checks } : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, findProjectRowRepo, projectMutating, projectRowDetail]
  )

  const rerunProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow, failedOnly: boolean): Promise<void> => {
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
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.rerunPRChecks',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            headSha: projectRowDetail?.provider === 'github' ? projectRowDetail.headSha : undefined,
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
        setProjectRowDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, findProjectRowRepo, projectMutating, projectRowDetail]
  )

  const toggleProjectGitHubFileViewed = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || row.itemType !== 'PULL_REQUEST' || !repo) {
        return
      }
      if (projectRowDetail?.provider !== 'github' || !projectRowDetail.pullRequestId) {
        setProjectRowDetailError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.setPRFileViewed',
          {
            repo: `id:${repo.id}`,
            prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost),
            pullRequestId: projectRowDetail.pullRequestId,
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
        setProjectRowDetail((current) =>
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
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update viewed state'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [activeGitHubProjectHost, client, findProjectRowRepo, projectMutating, projectRowDetail]
  )
  return Object.assign(model, {
    requestProjectGitHubReviewers,
    refreshProjectGitHubChecks,
    rerunProjectGitHubChecks,
    toggleProjectGitHubFileViewed
  })
}

export type ProjectReviewCheckActionsModel = ReturnType<
  typeof useMobileTasksProjectReviewCheckActions
>
