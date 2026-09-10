import type { ProjectDetailLoadingModel } from './use-mobile-tasks-project-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import { splitRepositorySlug } from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectMetadataLoading(model: ProjectDetailLoadingModel) {
  const {
    activeGitHubProjectHost,
    projectIssueTypeRepository,
    projectMetadataRepository,
    projectMetadataSeedLogins,
    setProjectAssignableUsers,
    setProjectAssignableUsersError,
    setProjectAssignableUsersLoading,
    setProjectAvailableLabels,
    setProjectIssueTypes,
    setProjectIssueTypesError,
    setProjectIssueTypesLoading,
    setProjectLabelsError,
    setProjectLabelsLoading,
    taskOperations,
    tasksSupported
  } = model
  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !taskOperations || !slug) {
      setProjectAvailableLabels([])
      setProjectLabelsLoading(false)
      setProjectLabelsError('')
      return
    }

    let stale = false
    setProjectAvailableLabels([])
    setProjectLabelsError('')
    setProjectLabelsLoading(true)
    void taskOperations.projectRead
      .listItemLabels({ owner: slug.owner, repo: slug.repo, host: activeGitHubProjectHost })
      .then((labels) => {
        if (stale) {
          return
        }
        setProjectAvailableLabels(labels)
      })
      .catch((err) => {
        if (!stale) {
          setProjectLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectLabelsLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [activeGitHubProjectHost, projectMetadataRepository, taskOperations, tasksSupported])

  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !taskOperations || !slug) {
      setProjectAssignableUsers([])
      setProjectAssignableUsersLoading(false)
      setProjectAssignableUsersError('')
      return
    }

    let stale = false
    setProjectAssignableUsers([])
    setProjectAssignableUsersError('')
    setProjectAssignableUsersLoading(true)
    void taskOperations.projectRead
      .listItemAssignableUsers({
        owner: slug.owner,
        repo: slug.repo,
        host: activeGitHubProjectHost,
        ...(projectMetadataSeedLogins ? { seedLogins: projectMetadataSeedLogins.split(',') } : {})
      })
      .then((users) => {
        if (stale) {
          return
        }
        setProjectAssignableUsers(users)
      })
      .catch((err) => {
        if (!stale) {
          setProjectAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    activeGitHubProjectHost,
    projectMetadataRepository,
    projectMetadataSeedLogins,
    taskOperations,
    tasksSupported
  ])

  useEffect(() => {
    const slug = splitRepositorySlug(projectIssueTypeRepository)
    if (!tasksSupported || !taskOperations || !slug) {
      setProjectIssueTypes([])
      setProjectIssueTypesLoading(false)
      setProjectIssueTypesError('')
      return
    }

    let stale = false
    setProjectIssueTypes([])
    setProjectIssueTypesError('')
    setProjectIssueTypesLoading(true)
    void taskOperations.projectRead
      .listIssueTypes({ owner: slug.owner, repo: slug.repo, host: activeGitHubProjectHost })
      .then((types) => {
        if (stale) {
          return
        }
        setProjectIssueTypes(types)
      })
      .catch((err) => {
        if (!stale) {
          setProjectIssueTypesError(
            err instanceof Error ? err.message : 'Failed to load issue types'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectIssueTypesLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [activeGitHubProjectHost, projectIssueTypeRepository, taskOperations, tasksSupported])
  return model
}

export type ProjectMetadataLoadingModel = ReturnType<typeof useMobileTasksProjectMetadataLoading>
