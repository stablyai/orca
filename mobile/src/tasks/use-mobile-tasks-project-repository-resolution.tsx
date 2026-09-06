import type { ProjectProjectionModel } from './use-mobile-tasks-project-projection'
import {
  type GitHubOwnerRepo,
  githubProjectKey,
  useEffect,
  useMemo
} from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  getGitHubReviewerSeedUsers,
  isSuccess,
  mapWithConcurrency,
  mergeGitHubAssignableUsers,
  projectRowType
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectRepositoryResolution(model: ProjectProjectionModel) {
  const {
    actionItem,
    activeGitHubProject,
    client,
    connState,
    detailPayload,
    findProjectRowRepo,
    githubMode,
    githubProjectSettings,
    githubProjectTable,
    githubProjectViews,
    githubRepoSlugCache,
    hostedRepos,
    itemAssignableUsers,
    projectAssignableUsers,
    projectRowDetail,
    projectRowItem,
    provider,
    setGithubRepoSlugCache,
    taskStateHydrated,
    tasksSupported
  } = model
  useEffect(() => {
    if (
      !client ||
      connState !== 'connected' ||
      !tasksSupported ||
      !taskStateHydrated ||
      provider !== 'github' ||
      githubMode !== 'project'
    ) {
      return
    }
    const missing = hostedRepos.filter((repo) => {
      const cached = githubRepoSlugCache[repo.id]
      return !cached || cached.path !== repo.path
    })
    if (missing.length === 0) {
      return
    }

    let cancelled = false
    void mapWithConcurrency(missing, GITHUB_REPO_CONCURRENCY, async (repo) => {
      try {
        const response = await client.sendRequest(
          'github.repoSlug',
          { repo: `id:${repo.id}` },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as GitHubOwnerRepo | null
        return { repoId: repo.id, entry: { path: repo.path, repository: result } }
      } catch {
        // Cached so readiness settles; `failed` marks it for retry on refresh.
        return { repoId: repo.id, entry: { path: repo.path, repository: null, failed: true } }
      }
    }).then((entries) => {
      if (cancelled) {
        return
      }
      setGithubRepoSlugCache((current) => {
        const next = { ...current }
        for (const entry of entries) {
          next[entry.repoId] = entry.entry
        }
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    client,
    connState,
    githubMode,
    githubRepoSlugCache,
    hostedRepos,
    provider,
    taskStateHydrated,
    tasksSupported
  ])
  const activeGitHubProjectKey = activeGitHubProject ? githubProjectKey(activeGitHubProject) : null
  const activeGitHubProjectViewId = activeGitHubProjectKey
    ? githubProjectSettings.lastViewByProject[activeGitHubProjectKey]?.viewId
    : undefined
  const activeGitHubProjectView =
    githubProjectViews.find((view) => view.id === activeGitHubProjectViewId) ??
    (githubProjectTable
      ? {
          id: githubProjectTable.selectedView.id,
          number: githubProjectTable.selectedView.number,
          name: githubProjectTable.selectedView.name,
          layout: githubProjectTable.selectedView.layout
        }
      : null)
  const projectIssueTypeRepository =
    projectRowItem?.itemType === 'ISSUE' ? projectRowItem.content.repository : null
  const projectMetadataRepository =
    projectRowItem && projectRowType(projectRowItem) ? projectRowItem.content.repository : null
  const projectRowHostedRepo = useMemo(
    () => (projectRowItem ? findProjectRowRepo(projectRowItem) : null),
    [findProjectRowRepo, projectRowItem]
  )
  const itemReviewerCandidates = useMemo(() => {
    if (!actionItem || actionItem.provider !== 'github' || actionItem.source.type !== 'pr') {
      return []
    }
    const reviewerSeedUsers = getGitHubReviewerSeedUsers({
      reviewRequests:
        detailPayload?.provider === 'github'
          ? detailPayload.reviewRequests
          : actionItem.source.reviewRequests,
      latestReviews:
        detailPayload?.provider === 'github'
          ? detailPayload.latestReviews
          : actionItem.source.latestReviews,
      author: actionItem.source.author
    })
    const authorLogin = actionItem.source.author?.trim().toLowerCase() ?? null
    return mergeGitHubAssignableUsers(itemAssignableUsers, reviewerSeedUsers).filter(
      (user) => user.login.trim().toLowerCase() !== authorLogin
    )
  }, [actionItem, detailPayload, itemAssignableUsers])
  const itemSelectedReviewerLogins = useMemo(() => {
    if (!actionItem || actionItem.provider !== 'github' || actionItem.source.type !== 'pr') {
      return new Set<string>()
    }
    const reviewRequests =
      detailPayload?.provider === 'github'
        ? detailPayload.reviewRequests
        : (actionItem.source.reviewRequests ?? [])
    return new Set(
      reviewRequests.map((reviewer) => reviewer.login.trim().toLowerCase()).filter(Boolean)
    )
  }, [actionItem, detailPayload])
  const projectReviewerCandidates = useMemo(() => {
    if (
      !projectRowItem ||
      projectRowItem.itemType !== 'PULL_REQUEST' ||
      projectRowDetail?.provider !== 'github'
    ) {
      return []
    }
    const reviewerSeedUsers = getGitHubReviewerSeedUsers({
      reviewRequests: projectRowDetail.reviewRequests,
      latestReviews: projectRowDetail.latestReviews
    })
    return mergeGitHubAssignableUsers(projectAssignableUsers, reviewerSeedUsers)
  }, [projectAssignableUsers, projectRowDetail, projectRowItem])
  const projectSelectedReviewerLogins = useMemo(() => {
    if (projectRowDetail?.provider !== 'github') {
      return new Set<string>()
    }
    return new Set(
      projectRowDetail.reviewRequests
        .map((reviewer) => reviewer.login.trim().toLowerCase())
        .filter(Boolean)
    )
  }, [projectRowDetail])
  const projectMetadataSeedLogins = useMemo(() => {
    const logins = new Set<string>()
    for (const assignee of projectRowItem?.content.assignees ?? []) {
      const login = assignee.login.trim()
      if (login) {
        logins.add(login)
      }
    }
    for (const reviewer of projectRowDetail?.provider === 'github'
      ? getGitHubReviewerSeedUsers(projectRowDetail)
      : []) {
      const login = reviewer.login.trim()
      if (login) {
        logins.add(login)
      }
    }
    return [...logins].sort().join(',')
  }, [projectRowDetail, projectRowItem?.content.assignees])
  return Object.assign(model, {
    activeGitHubProjectKey,
    activeGitHubProjectViewId,
    activeGitHubProjectView,
    projectIssueTypeRepository,
    projectMetadataRepository,
    projectRowHostedRepo,
    itemReviewerCandidates,
    itemSelectedReviewerLogins,
    projectReviewerCandidates,
    projectSelectedReviewerLogins,
    projectMetadataSeedLogins
  })
}

export type ProjectRepositoryResolutionModel = ReturnType<
  typeof useMobileTasksProjectRepositoryResolution
>
