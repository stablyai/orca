import type { ProjectLoadingActionsModel } from './use-mobile-tasks-project-loading-actions'
import {
  View,
  clearMobileTaskCopyFeedbackTimer,
  dropFailedGitHubRepoSlugEntries,
  useCallback,
  useEffect
} from './mobile-tasks-dependencies'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from './mobile-tasks-legacy-foundation'
import { taskLinearTarget } from './mobile-tasks-mutation-targets'

export function useMobileTasksListAndDetailEffects(model: ProjectLoadingActionsModel) {
  const {
    actionItem,
    activeGitHubProject,
    activeGitHubProjectViewId,
    appliedGithubProjectSearch,
    appliedQuery,
    connState,
    copiedLinkResetTimerRef,
    githubKind,
    githubMode,
    githubPreset,
    hostedRepos,
    linearConnected,
    linearFilter,
    linearMetadataItem,
    loadGitHubProjectTable,
    loadGitHubProjects,
    loadLinearContext,
    loadTasks,
    persistTaskResumeState,
    provider,
    query,
    refreshTasks,
    selectGitHubProject,
    setAppliedQuery,
    setCreateRepoId,
    setCreateTeamId,
    setCreatingTask,
    setError,
    setExpandedPrFilePath,
    setExpandedResolvedCommentGroups,
    setGithubProjectError,
    setGithubRepoSlugCache,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemBodyDraft,
    setItemCommentDraft,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItemReplyDrafts,
    setItemReviewersDraft,
    setItemTitleDraft,
    setLinearCommentDraft,
    setLinearStates,
    setLinearStatesLoading,
    setLinearSubIssueTitle,
    setLinearTeams,
    setPrFileCommentDrafts,
    setPrFileContents,
    setPrFileLoadingPath,
    showCreateTask,
    showGitHubProjectPicker,
    taskOperations,
    taskStateHydrated,
    taskUiReady,
    tasksSupported
  } = model
  const refreshGitHubProject = useCallback(() => {
    setGithubRepoSlugCache(dropFailedGitHubRepoSlugEntries)
    refreshTasks()
    void loadGitHubProjectTable({ queryOverride: appliedGithubProjectSearch })
  }, [appliedGithubProjectSearch, loadGitHubProjectTable, refreshTasks])

  useEffect(() => {
    if (!taskStateHydrated) {
      return
    }
    const timer = setTimeout(() => {
      setAppliedQuery(
        provider === 'github' ? scopeGitHubTaskSearch(query, githubKind) : query.trim()
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [githubKind, provider, query, taskStateHydrated])

  const setTaskCopyFeedbackRootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      return
    }
    // Why: copied-link feedback is screen-local; clear the pending reset when
    // the Tasks screen detaches without a passive cleanup-only Effect.
    clearMobileTaskCopyFeedbackTimer(copiedLinkResetTimerRef)
  }, [])

  useEffect(() => {
    if (!taskUiReady || provider !== 'github' || githubMode !== 'items') {
      return
    }
    const trimmed = appliedQuery.trim()
    persistTaskResumeState({
      githubMode: 'items',
      githubItemsPreset: trimmed === getTaskPresetQuery(githubPreset) ? githubPreset : null,
      githubItemsQuery: trimmed
    })
  }, [appliedQuery, githubMode, githubPreset, persistTaskResumeState, provider, taskUiReady])

  useEffect(() => {
    if (!taskUiReady || provider !== 'linear') {
      return
    }
    persistTaskResumeState({
      linearPreset: linearFilter,
      linearQuery: appliedQuery.trim()
    })
  }, [appliedQuery, linearFilter, persistTaskResumeState, provider, taskUiReady])

  useEffect(() => {
    if (connState !== 'connected' || !taskStateHydrated) {
      return
    }
    void loadTasks()
  }, [connState, loadTasks, taskStateHydrated])

  useEffect(() => {
    if (!taskStateHydrated || provider !== 'linear' || !linearConnected) {
      return
    }
    void loadLinearContext().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load Linear context')
    })
  }, [linearConnected, loadLinearContext, provider, taskStateHydrated])

  useEffect(() => {
    if (!taskUiReady || provider !== 'github' || githubMode !== 'project') {
      return
    }
    persistTaskResumeState({ githubMode: 'project' })
    if (activeGitHubProject && activeGitHubProjectViewId) {
      void loadGitHubProjectTable({ queryOverride: appliedGithubProjectSearch })
    } else if (activeGitHubProject) {
      void selectGitHubProject(activeGitHubProject)
    } else {
      void loadGitHubProjects().catch((err) => {
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
      })
    }
  }, [
    activeGitHubProject,
    activeGitHubProjectViewId,
    appliedGithubProjectSearch,
    githubMode,
    loadGitHubProjectTable,
    loadGitHubProjects,
    persistTaskResumeState,
    provider,
    selectGitHubProject,
    taskUiReady
  ])

  useEffect(() => {
    if (!taskUiReady || !showGitHubProjectPicker) {
      return
    }
    void loadGitHubProjects().catch((err) => {
      setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
    })
  }, [loadGitHubProjects, showGitHubProjectPicker, taskUiReady])

  useEffect(() => {
    if (!tasksSupported || !taskStateHydrated || !showCreateTask) {
      return
    }
    setCreatingTask(false)
    if (provider === 'github' || provider === 'gitlab') {
      setCreateRepoId((current) =>
        current && hostedRepos.some((repo) => repo.id === current)
          ? current
          : (hostedRepos[0]?.id ?? null)
      )
      return
    }
    if (!taskOperations) {
      return
    }
    let stale = false
    setCreateTeamId(null)
    void taskOperations.linear
      .listTeams()
      .then((teams) => {
        if (stale) {
          return
        }
        setLinearTeams(teams)
        setCreateTeamId((current) => current ?? teams[0]?.id ?? null)
      })
      .catch(() => {
        if (!stale) {
          setLinearTeams([])
          setCreateTeamId(null)
        }
      })
    return () => {
      stale = true
    }
  }, [hostedRepos, provider, showCreateTask, taskOperations, taskStateHydrated, tasksSupported])

  useEffect(() => {
    if (!tasksSupported || !linearMetadataItem || !taskOperations) {
      setLinearStates([])
      setLinearCommentDraft('')
      setLinearSubIssueTitle('')
      return
    }
    let stale = false
    setLinearStatesLoading(true)
    setLinearCommentDraft('')
    setLinearSubIssueTitle('')
    void taskOperations.linear
      .teamStates(taskLinearTarget(linearMetadataItem))
      .then((states) => {
        if (stale) {
          return
        }
        setLinearStates(states)
      })
      .catch(() => {
        if (!stale) {
          setLinearStates([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLinearStatesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [linearMetadataItem, taskOperations, tasksSupported])

  useEffect(() => {
    if (!actionItem) {
      setItemTitleDraft('')
      setItemBodyDraft('')
      setItemCommentDraft('')
      setItemAddLabelsDraft('')
      setItemRemoveLabelsDraft('')
      setItemAddAssigneesDraft('')
      setItemRemoveAssigneesDraft('')
      setItemReviewersDraft('')
      setItemReplyDrafts({})
      setExpandedPrFilePath(null)
      setPrFileContents({})
      setPrFileLoadingPath(null)
      setPrFileCommentDrafts({})
      setExpandedResolvedCommentGroups(new Set())
      return
    }
    setItemTitleDraft(actionItem.title)
    setItemBodyDraft('')
    setItemCommentDraft('')
    setItemAddLabelsDraft('')
    setItemRemoveLabelsDraft('')
    setItemAddAssigneesDraft('')
    setItemRemoveAssigneesDraft('')
    setItemReviewersDraft('')
    setItemReplyDrafts({})
    setExpandedPrFilePath(null)
    setPrFileContents({})
    setPrFileLoadingPath(null)
    setPrFileCommentDrafts({})
    setExpandedResolvedCommentGroups(new Set())
  }, [actionItem])
  return Object.assign(model, { refreshGitHubProject, setTaskCopyFeedbackRootRef })
}

export type ListAndDetailEffectsModel = ReturnType<typeof useMobileTasksListAndDetailEffects>
