import type { TaskPaginationActionsModel } from './use-mobile-tasks-task-pagination-actions'
import {
  type GitHubProjectRef,
  type GitHubProjectSettings,
  type GitHubProjectViewSummary,
  githubProjectHost,
  githubProjectKey,
  parseProjectInput,
  useCallback
} from './mobile-tasks-dependencies'

export function useMobileTasksProjectLoadingActions(model: TaskPaginationActionsModel) {
  const {
    activeGitHubProject,
    activeGitHubProjectHost,
    activeGitHubProjectViewId,
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
    taskProjectReadOperations,
    taskStateHydrated,
    tasksSupported
  } = model
  const loadGitHubProjects = useCallback(async (): Promise<void> => {
    if (!taskProjectReadOperations || connState !== 'connected' || !tasksSupported) {
      return
    }
    setGithubProjectError('')
    setGithubProjectPartialFailures([])
    const result = await taskProjectReadOperations.listAccessible('github.com')
    setGithubProjects(result.projects)
    setGithubProjectPartialFailures(result.partialFailures)
  }, [connState, taskProjectReadOperations, tasksSupported])
  const loadGitHubProjectViews = useCallback(
    async (project: GitHubProjectRef): Promise<GitHubProjectViewSummary[]> => {
      if (
        !taskProjectReadOperations ||
        connState !== 'connected' ||
        !tasksSupported ||
        !taskStateHydrated
      ) {
        return []
      }
      const views = await taskProjectReadOperations.listViews({
        owner: project.owner,
        host: githubProjectHost(project.host),
        ownerType: project.ownerType,
        number: project.number
      })
      setGithubProjectViews(views)
      return views
    },
    [connState, taskProjectReadOperations, taskStateHydrated, tasksSupported]
  )
  const loadGitHubProjectTable = useCallback(
    async (options: { force?: boolean; queryOverride?: string } = {}): Promise<void> => {
      if (
        !taskProjectReadOperations ||
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
        const table = await taskProjectReadOperations.loadTable({
          owner: activeGitHubProject.owner,
          host: activeGitHubProjectHost,
          ownerType: activeGitHubProject.ownerType,
          number: activeGitHubProject.number,
          viewId: activeGitHubProjectViewId,
          ...(options.queryOverride !== undefined ? { queryOverride: options.queryOverride } : {})
        })
        setGithubProjectTable(table)
        setGithubProjectSearch(options.queryOverride ?? table.selectedView.filter ?? '')
        setGithubProjectViews((current) =>
          current.some((view) => view.id === table.selectedView.id)
            ? current
            : [
                ...current,
                {
                  id: table.selectedView.id,
                  number: table.selectedView.number,
                  name: table.selectedView.name,
                  layout: table.selectedView.layout
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
      connState,
      taskProjectReadOperations,
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
    if (
      !taskProjectReadOperations ||
      connState !== 'connected' ||
      !tasksSupported ||
      !taskStateHydrated
    ) {
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
      const result = await taskProjectReadOperations.resolveRef({
        input,
        host: githubProjectHost(parsed.host)
      })
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
    connState,
    githubProjectPasteInput,
    selectGitHubProject,
    taskProjectReadOperations,
    taskStateHydrated,
    tasksSupported
  ])
  const refreshTasks = useCallback(() => {
    void repoListReload().catch(() => {})
    void loadTasks({ silent: true })
  }, [loadTasks, repoListReload])
  return Object.assign(model, {
    commitGitHubProjectView,
    loadGitHubProjectTable,
    loadGitHubProjectViews,
    loadGitHubProjects,
    refreshTasks,
    resolveGitHubProjectFromInput,
    selectGitHubProject
  })
}

export type ProjectLoadingActionsModel = ReturnType<typeof useMobileTasksProjectLoadingActions>
