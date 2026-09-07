import type { TaskPaginationActionsModel } from './use-mobile-tasks-task-pagination-actions'
import {
  type GitHubProjectOwnerType,
  type GitHubProjectPartialFailure,
  type GitHubProjectRef,
  type GitHubProjectSettings,
  type GitHubProjectSummary,
  type GitHubProjectViewSummary,
  githubProjectHost,
  githubProjectKey,
  parseProjectInput,
  useCallback
} from './mobile-tasks-dependencies'
import { type GitHubProjectTable, isSuccess } from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectLoadingActions(model: TaskPaginationActionsModel) {
  const {
    activeGitHubProject,
    activeGitHubProjectHost,
    activeGitHubProjectViewId,
    client,
    connState,
    githubProjectPasteInput,
    githubProjectSettings,
    loadTasks,
    persistGitHubProjectSettings,
    repoListReload,
    setAppliedGithubProjectSearch,
    setGithubProjectError,
    setGithubProjectLoading,
    setGithubProjectPartialFailures,
    setGithubProjectPasteBusy,
    setGithubProjectPasteError,
    setGithubProjectPasteInput,
    setGithubProjectSearch,
    setGithubProjectTable,
    setGithubProjectViews,
    setGithubProjects,
    setPendingGitHubProjectViewSelection,
    setShowGitHubProjectPicker,
    setShowGitHubProjectViewPicker,
    taskStateHydrated,
    tasksSupported
  } = model
  const loadGitHubProjects = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    setGithubProjectError('')
    setGithubProjectPartialFailures([])
    const response = await client.sendRequest('github.project.listAccessible', {
      host: 'github.com'
    })
    if (!isSuccess(response)) {
      throw new Error(response.error.message)
    }
    const result = response.result as
      | {
          ok: true
          projects: GitHubProjectSummary[]
          partialFailures?: GitHubProjectPartialFailure[]
        }
      | { ok: false; error: { message: string } }
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    setGithubProjects(result.projects)
    setGithubProjectPartialFailures(result.partialFailures ?? [])
  }, [client, connState, tasksSupported])

  const loadGitHubProjectViews = useCallback(
    async (project: GitHubProjectRef): Promise<GitHubProjectViewSummary[]> => {
      if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
        return []
      }
      const response = await client.sendRequest('github.project.listViews', {
        owner: project.owner,
        host: githubProjectHost(project.host),
        ownerType: project.ownerType,
        projectNumber: project.number
      })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as
        | { ok: true; views: GitHubProjectViewSummary[] }
        | { ok: false; error: { message: string } }
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      setGithubProjectViews(result.views)
      return result.views
    },
    [client, connState, taskStateHydrated, tasksSupported]
  )

  const loadGitHubProjectTable = useCallback(
    async (options: { force?: boolean; queryOverride?: string } = {}): Promise<void> => {
      if (
        !client ||
        connState !== 'connected' ||
        !tasksSupported ||
        !activeGitHubProject ||
        !activeGitHubProjectViewId
      ) {
        setGithubProjectTable(null)
        return
      }
      setGithubProjectLoading(true)
      setGithubProjectError('')
      try {
        const response = await client.sendRequest(
          'github.project.viewTable',
          {
            owner: activeGitHubProject.owner,
            host: activeGitHubProjectHost,
            ownerType: activeGitHubProject.ownerType,
            projectNumber: activeGitHubProject.number,
            viewId: activeGitHubProjectViewId,
            ...(options.queryOverride !== undefined ? { queryOverride: options.queryOverride } : {})
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; data: GitHubProjectTable }
          | { ok: false; error: { message: string }; totalCount?: number }
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        setGithubProjectTable(result.data)
        setGithubProjectSearch(options.queryOverride ?? result.data.selectedView.filter ?? '')
        setGithubProjectViews((current) =>
          current.some((view) => view.id === result.data.selectedView.id)
            ? current
            : [
                ...current,
                {
                  id: result.data.selectedView.id,
                  number: result.data.selectedView.number,
                  name: result.data.selectedView.name,
                  layout: result.data.selectedView.layout
                }
              ]
        )
      } catch (err) {
        setGithubProjectTable(null)
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to load project view')
      } finally {
        setGithubProjectLoading(false)
      }
    },
    [
      activeGitHubProject,
      activeGitHubProjectHost,
      activeGitHubProjectViewId,
      client,
      connState,
      tasksSupported
    ]
  )

  const commitGitHubProjectView = useCallback(
    (project: GitHubProjectRef, viewId: string): void => {
      const projectKey = githubProjectKey(project)
      const nextSettings: GitHubProjectSettings = {
        ...githubProjectSettings,
        recent: [
          { ...project, lastOpenedAt: new Date().toISOString() },
          ...githubProjectSettings.recent.filter((entry) => githubProjectKey(entry) !== projectKey)
        ].slice(0, 10),
        lastViewByProject: {
          ...githubProjectSettings.lastViewByProject,
          [projectKey]: { viewId }
        },
        activeProject: project
      }
      persistGitHubProjectSettings(nextSettings)
      setAppliedGithubProjectSearch(undefined)
      setGithubProjectSearch('')
      setGithubProjectTable(null)
    },
    [githubProjectSettings, persistGitHubProjectSettings]
  )

  const selectGitHubProject = useCallback(
    async (project: GitHubProjectRef, options: { viewNumber?: number } = {}): Promise<void> => {
      if (!tasksSupported || !taskStateHydrated) {
        return
      }
      setGithubProjectLoading(true)
      setGithubProjectError('')
      try {
        const views = await loadGitHubProjectViews(project)
        const projectKey = githubProjectKey(project)
        const rememberedView = githubProjectSettings.lastViewByProject[projectKey]?.viewId
        const explicitView =
          typeof options.viewNumber === 'number'
            ? views.find((view) => view.number === options.viewNumber)
            : undefined
        if (options.viewNumber !== undefined && !explicitView) {
          // Why: desktop treats stale /views/{n} URLs as a prompt to choose a
          // replacement view, not as a failed project selection.
          const supportedViews = views.filter((view) => view.layout === 'TABLE_LAYOUT')
          if (supportedViews.length === 0) {
            throw new Error('This project has no supported views.')
          }
          setPendingGitHubProjectViewSelection(project)
          setShowGitHubProjectViewPicker(true)
          return
        }
        if (explicitView && explicitView.layout !== 'TABLE_LAYOUT') {
          throw new Error("Orca doesn't support this GitHub Project layout yet.")
        }
        if (!explicitView && !rememberedView) {
          // Why: desktop asks which Project view to open the first time a project
          // is selected. Mobile should not silently choose the first table view.
          const supportedViews = views.filter((view) => view.layout === 'TABLE_LAYOUT')
          if (supportedViews.length === 0) {
            throw new Error('This project has no supported views.')
          }
          setPendingGitHubProjectViewSelection(project)
          setShowGitHubProjectViewPicker(true)
          return
        }
        const selectedView =
          explicitView ??
          views.find((view) => view.id === rememberedView && view.layout === 'TABLE_LAYOUT') ??
          undefined
        if (!selectedView) {
          throw new Error('This project has no supported views.')
        }
        commitGitHubProjectView(project, selectedView.id)
      } catch (err) {
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to select project')
      } finally {
        setGithubProjectLoading(false)
      }
    },
    [
      commitGitHubProjectView,
      githubProjectSettings,
      loadGitHubProjectViews,
      taskStateHydrated,
      tasksSupported
    ]
  )

  const resolveGitHubProjectFromInput = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
      return
    }
    const input = githubProjectPasteInput.trim()
    const parsed = parseProjectInput(input)
    if (!parsed) {
      setGithubProjectPasteError('Expected a project URL or owner/number.')
      return
    }
    setGithubProjectPasteBusy(true)
    setGithubProjectPasteError('')
    setGithubProjectError('')
    try {
      const response = await client.sendRequest('github.project.resolveRef', {
        input,
        host: githubProjectHost(parsed.host)
      })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as
        | {
            ok: true
            owner: string
            ownerType: GitHubProjectOwnerType
            number: number
            title: string
            host?: string
            viewNumber?: number
          }
        | { ok: false; error: { message: string } }
      if (!result.ok) {
        setGithubProjectPasteError(result.error.message)
        return
      }
      setGithubProjectPasteInput('')
      setShowGitHubProjectPicker(false)
      await selectGitHubProject(
        {
          owner: result.owner,
          ownerType: result.ownerType,
          number: result.number,
          host: githubProjectHost(result.host ?? parsed.host)
        },
        { viewNumber: result.viewNumber }
      )
    } catch (err) {
      setGithubProjectPasteError(err instanceof Error ? err.message : 'Failed to add project.')
    } finally {
      setGithubProjectPasteBusy(false)
    }
  }, [
    client,
    connState,
    githubProjectPasteInput,
    selectGitHubProject,
    taskStateHydrated,
    tasksSupported
  ])

  // Why: a refresh must re-read the host, not replay the cached list, or a repo
  // added since this screen mounted can never appear.
  const refreshTasks = useCallback(() => {
    void repoListReload().catch(() => {})
    void loadTasks({ silent: true })
  }, [loadTasks, repoListReload])
  return Object.assign(model, {
    loadGitHubProjects,
    loadGitHubProjectViews,
    loadGitHubProjectTable,
    commitGitHubProjectView,
    selectGitHubProject,
    resolveGitHubProjectFromInput,
    refreshTasks
  })
}

export type ProjectLoadingActionsModel = ReturnType<typeof useMobileTasksProjectLoadingActions>
