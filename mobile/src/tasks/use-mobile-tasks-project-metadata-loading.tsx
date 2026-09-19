import type { ProjectDetailLoadingModel } from './use-mobile-tasks-project-detail-loading'
import { useEffect } from './mobile-tasks-dependencies'
import { type GitHubIssueType, splitRepositorySlug } from './mobile-tasks-legacy-foundation'
import {
  githubProjectAssignableUserListRead,
  githubProjectIssueTypeListRead,
  githubProjectLabelListRead
} from './mobile-task-project-board-operations'

export function useMobileTasksProjectMetadataLoading(model: ProjectDetailLoadingModel) {
  const {
    activeGitHubProjectHost,
    client,
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
    tasksSupported
  } = model
  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectAvailableLabels([])
      setProjectLabelsLoading(false)
      setProjectLabelsError('')
      return
    }

    let stale = false
    setProjectAvailableLabels([])
    setProjectLabelsError('')
    setProjectLabelsLoading(true)
    void githubProjectLabelListRead
      .request(
        client,
        { owner: slug.owner, repo: slug.repo, host: activeGitHubProjectHost },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        const result = githubProjectLabelListRead.interpret(response)
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load labels')
        }
        setProjectAvailableLabels(result.labels ?? [])
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
  }, [activeGitHubProjectHost, client, projectMetadataRepository, tasksSupported])

  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectAssignableUsers([])
      setProjectAssignableUsersLoading(false)
      setProjectAssignableUsersError('')
      return
    }

    let stale = false
    setProjectAssignableUsers([])
    setProjectAssignableUsersError('')
    setProjectAssignableUsersLoading(true)
    void githubProjectAssignableUserListRead
      .request(
        client,
        {
          owner: slug.owner,
          repo: slug.repo,
          host: activeGitHubProjectHost,
          ...(projectMetadataSeedLogins ? { seedLogins: projectMetadataSeedLogins.split(',') } : {})
        },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        const result = githubProjectAssignableUserListRead.interpret(response)
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load assignees')
        }
        setProjectAssignableUsers(result.users ?? [])
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
    client,
    projectMetadataRepository,
    projectMetadataSeedLogins,
    tasksSupported
  ])

  useEffect(() => {
    const slug = splitRepositorySlug(projectIssueTypeRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectIssueTypes([])
      setProjectIssueTypesLoading(false)
      setProjectIssueTypesError('')
      return
    }

    let stale = false
    setProjectIssueTypes([])
    setProjectIssueTypesError('')
    setProjectIssueTypesLoading(true)
    void githubProjectIssueTypeListRead
      .request(
        client,
        { owner: slug.owner, repo: slug.repo, host: activeGitHubProjectHost },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        const result = githubProjectIssueTypeListRead.interpret(response)
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load issue types')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires the `id` the issue-type write sends and types `name`; `color` and `description` are declared non-nullable by GitHubIssueType but absent from the recorded reply, so requiring them would drop a row main renders.
        setProjectIssueTypes((result.types ?? []) as GitHubIssueType[])
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
  }, [activeGitHubProjectHost, client, projectIssueTypeRepository, tasksSupported])
  return model
}

export type ProjectMetadataLoadingModel = ReturnType<typeof useMobileTasksProjectMetadataLoading>
