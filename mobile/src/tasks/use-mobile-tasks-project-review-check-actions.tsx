import type { ProjectMetadataActionsModel } from './use-mobile-tasks-project-metadata-actions'
import { useCallback } from './mobile-tasks-dependencies'
import {
  type GitHubAssignableUser,
  type GitHubDetailFile,
  type GitHubProjectRow,
  projectRowMutationTarget,
  splitReviewerList
} from './mobile-tasks-model'

export function useMobileTasksProjectReviewCheckActions(model: ProjectMetadataActionsModel) {
  const {
    activeGitHubProjectHost,
    findProjectRowRepo,
    projectMutating,
    projectReviewersDraft,
    projectRowDetail,
    setProjectMutating,
    setProjectReviewersDraft,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowDetailRefreshSeq,
    taskProjectFileOperations,
    taskProjectMutationOperations
  } = model
  const requestProjectGitHubReviewers = useCallback(
    async (row: GitHubProjectRow, logins?: string[]): Promise<void> => {
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
      const reviewers = logins ?? splitReviewerList(projectReviewersDraft)
      if (reviewers.length === 0 || !row.content.number) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskProjectMutationOperations.requestReviewers(target, repo.id, reviewers)
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
      findProjectRowRepo,
      projectMutating,
      projectReviewersDraft,
      projectRowDetail,
      taskProjectMutationOperations
    ]
  )
  const refreshProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
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
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const checks = await taskProjectFileOperations.refreshChecks(
          target,
          repo.id,
          projectRowDetail?.provider === 'github' ? projectRowDetail.headSha : undefined
        )
        setProjectRowDetail((current) =>
          current?.provider === 'github' ? { ...current, checks } : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [
      activeGitHubProjectHost,
      findProjectRowRepo,
      projectMutating,
      projectRowDetail,
      taskProjectFileOperations
    ]
  )
  const rerunProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow, failedOnly: boolean): Promise<void> => {
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
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskProjectMutationOperations.rerunChecks(target, repo.id, {
          ...(projectRowDetail?.provider === 'github' && projectRowDetail.headSha
            ? { headSha: projectRowDetail.headSha }
            : {}),
          failedOnly
        })
        setProjectRowDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [
      activeGitHubProjectHost,
      findProjectRowRepo,
      projectMutating,
      projectRowDetail,
      taskProjectMutationOperations
    ]
  )
  const toggleProjectGitHubFileViewed = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile): Promise<void> => {
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
      if (projectRowDetail?.provider !== 'github' || !projectRowDetail.pullRequestId) {
        setProjectRowDetailError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        await taskProjectFileOperations.setFileViewed(target, repo.id, {
          pullRequestId: projectRowDetail.pullRequestId,
          path: file.path,
          viewed
        })
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
    [
      activeGitHubProjectHost,
      findProjectRowRepo,
      projectMutating,
      projectRowDetail,
      taskProjectFileOperations
    ]
  )
  return Object.assign(model, {
    refreshProjectGitHubChecks,
    requestProjectGitHubReviewers,
    rerunProjectGitHubChecks,
    toggleProjectGitHubFileViewed
  })
}

export type ProjectReviewCheckActionsModel = ReturnType<
  typeof useMobileTasksProjectReviewCheckActions
>
