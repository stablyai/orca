import type { ProjectDetailLoadingModel } from './use-mobile-tasks-project-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import { splitRepositorySlug } from './mobile-tasks-model'

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
    taskProjectReadOperations,
    tasksSupported
  } = model
  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !taskProjectReadOperations || !slug) {
      setProjectAvailableLabels([])
      setProjectLabelsLoading(false)
      setProjectLabelsError('')
      return
    }

    let stale = false
    setProjectAvailableLabels([])
    setProjectLabelsError('')
    setProjectLabelsLoading(true)
    void taskProjectReadOperations
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
  }, [
    activeGitHubProjectHost,
    projectMetadataRepository,
    taskProjectReadOperations,
    tasksSupported
  ])
  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !taskProjectReadOperations || !slug) {
      setProjectAssignableUsers([])
      setProjectAssignableUsersLoading(false)
      setProjectAssignableUsersError('')
      return
    }

    let stale = false
    setProjectAssignableUsers([])
    setProjectAssignableUsersError('')
    setProjectAssignableUsersLoading(true)
    void taskProjectReadOperations
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
    taskProjectReadOperations,
    tasksSupported
  ])
  useEffect(() => {
    const slug = splitRepositorySlug(projectIssueTypeRepository)
    if (!tasksSupported || !taskProjectReadOperations || !slug) {
      setProjectIssueTypes([])
      setProjectIssueTypesLoading(false)
      setProjectIssueTypesError('')
      return
    }

    let stale = false
    setProjectIssueTypes([])
    setProjectIssueTypesError('')
    setProjectIssueTypesLoading(true)
    void taskProjectReadOperations
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
  }, [
    activeGitHubProjectHost,
    projectIssueTypeRepository,
    taskProjectReadOperations,
    tasksSupported
  ])
  return Object.assign(model, {})
}

export type ProjectMetadataLoadingModel = ReturnType<typeof useMobileTasksProjectMetadataLoading>
