import { githubTaskKey } from './github-task-identity'
import type { ProjectLoadingActionsModel } from './use-mobile-tasks-project-loading-actions'
import {
  type View,
  clearMobileTaskCopyFeedbackTimer,
  dropFailedGitHubRepoSlugEntries,
  useCallback,
  useLayoutEffect,
  useEffect
} from './mobile-tasks-dependencies'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from './mobile-tasks-legacy-foundation'
import {
  linearComposerTeamListRead,
  linearTeamStateListRead
} from './mobile-task-item-detail-operations'

export function useMobileTasksListAndDetailEffects(model: ProjectLoadingActionsModel) {
  const {
    actionItem,
    activeGitHubProject,
    activeGitHubProjectViewId,
    appliedGithubProjectSearch,
    appliedQuery,
    client,
    connState,
    copiedLinkResetTimerRef,
    githubKind,
    githubMode,
    githubPreset,
    hostedRepos,
    linearConnected,
    linearFilter,
    jiraFilter,
    refreshJiraConnection,
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
    setGithubProjectError,
    setGithubRepoSlugCache,
    setLinearCommentDraft,
    setLinearStates,
    setLinearStatesLoading,
    setLinearSubIssueTitle,
    setLinearTeams,
    showCreateTask,
    showGitHubProjectPicker,
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
    if (!taskUiReady || provider !== 'jira') {
      return
    }
    persistTaskResumeState({
      jiraPreset: jiraFilter,
      jiraQuery: appliedQuery.trim()
    })
  }, [appliedQuery, jiraFilter, persistTaskResumeState, provider, taskUiReady])

  // Pick up desktop connection changes when entering the Jira tab.
  useEffect(() => {
    if (!taskStateHydrated || provider !== 'jira') {
      return
    }
    let stale = false
    void refreshJiraConnection().catch((err) => {
      if (!stale) {
        setError(err instanceof Error ? err.message : 'Failed to read Jira status')
      }
    })
    return () => {
      stale = true
    }
  }, [provider, refreshJiraConnection, taskStateHydrated])

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
    if (!client) {
      return
    }
    let stale = false
    setCreateTeamId(null)
    void linearComposerTeamListRead
      .request(client)
      .then((response) => {
        if (stale) {
          return
        }
        const accepted = linearComposerTeamListRead.interpret(response)
        if (accepted.accepted) {
          const teams = accepted.value
          setLinearTeams(teams)
          setCreateTeamId((current) => current ?? teams[0]?.id ?? null)
        } else {
          setLinearTeams([])
          setCreateTeamId(null)
        }
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
  }, [client, hostedRepos, provider, showCreateTask, taskStateHydrated, tasksSupported])

  useEffect(() => {
    if (!tasksSupported || !linearMetadataItem || !client) {
      setLinearStates([])
      setLinearCommentDraft('')
      setLinearSubIssueTitle('')
      return
    }
    let stale = false
    setLinearStatesLoading(true)
    setLinearCommentDraft('')
    setLinearSubIssueTitle('')
    const baseParams = {
      teamId: linearMetadataItem.source.team.id,
      workspaceId: linearMetadataItem.source.workspaceId
    }
    void linearTeamStateListRead
      .request(client, baseParams)
      .then((statesResponse) => {
        if (stale) {
          return
        }
        const accepted = linearTeamStateListRead.interpret(statesResponse)
        setLinearStates(accepted.accepted ? accepted.value : [])
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
  }, [client, linearMetadataItem, tasksSupported])

  useMobileTasksItemSelectionEffects(model)

  const detailPayload =
    model.detailPayload?.provider === 'github' &&
    (actionItem?.provider !== 'github' ||
      model.detailPayload.targetKey !== githubTaskKey(actionItem.source))
      ? null
      : model.detailPayload
  return Object.assign(model, { detailPayload, refreshGitHubProject, setTaskCopyFeedbackRootRef })
}

export type ListAndDetailEffectsModel = ReturnType<typeof useMobileTasksListAndDetailEffects>

export function useMobileTasksItemSelectionEffects(
  model: Pick<
    ProjectLoadingActionsModel,
    | 'actionItem'
    | 'client'
    | 'detailPayload'
    | 'resetPrFiles'
    | 'setExpandedPrFilePath'
    | 'setExpandedResolvedCommentGroups'
    | 'setItemAddAssigneesDraft'
    | 'setItemAddLabelsDraft'
    | 'setItemBodyDraft'
    | 'setItemCommentDraft'
    | 'setItemRemoveAssigneesDraft'
    | 'setItemRemoveLabelsDraft'
    | 'setItemReplyDrafts'
    | 'setItemReviewersDraft'
    | 'setItemTitleDraft'
    | 'setPrFileCommentDrafts'
  >
) {
  const {
    actionItem,
    client,
    resetPrFiles,
    setExpandedPrFilePath,
    setExpandedResolvedCommentGroups,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemBodyDraft,
    setItemCommentDraft,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItemReplyDrafts,
    setItemReviewersDraft,
    setItemTitleDraft,
    setPrFileCommentDrafts
  } = model
  const actionIdentity =
    actionItem?.provider === 'github' ? githubTaskKey(actionItem.source) : actionItem?.key

  const fileRevision =
    model.detailPayload?.provider === 'github'
      ? [
          model.detailPayload.targetKey,
          model.detailPayload.headSha,
          model.detailPayload.baseSha
        ].join('\0')
      : null
  useLayoutEffect(() => {
    resetPrFiles()
  }, [actionIdentity, client, fileRevision, resetPrFiles])

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
      resetPrFiles()
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
    resetPrFiles()
    setPrFileCommentDrafts({})
    setExpandedResolvedCommentGroups(new Set())
  }, [actionItem])
}
