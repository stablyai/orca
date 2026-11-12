import { githubTaskKey } from '../item-detail/github-task-identity'
import { taskItemIdentity } from '../item-detail/task-draft-rows'
import { translate } from '../../i18n/mobile-i18n'
import type { ProjectLoadingActionsModel } from '../project-board/use-mobile-tasks-project-loading-actions'
import { clearMobileTaskCopyFeedbackTimer } from '../screen/mobile-task-copy-feedback-timer'
import { dropFailedGitHubRepoSlugEntries } from '../project-board/github-project-repo-match'
import { useCallback, useLayoutEffect, useEffect } from 'react'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'
import { scopeGitHubTaskSearch } from '../../../../src/shared/work-items/task-github-search'
import {
  linearComposerTeamListRead,
  linearTeamStateListRead
} from '../item-detail/mobile-task-item-detail-operations'

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
    repoListEnsureLoaded,
    selectGitHubProject,
    setAppliedQuery,
    setCreateRepoId,
    setCreateTeamId,
    setCreatingTask,
    setError,
    setGithubProjectError,
    setGithubRepoSlugCache,
    setLinearStates,
    setLinearStatesError,
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

  const setTaskCopyFeedbackRootRef = useCallback((node: unknown): void => {
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

  // Repos load beside the hydration reads, so the first list read waits on one round trip, not two.
  useEffect(() => {
    if (tasksSupported) {
      void repoListEnsureLoaded().catch(() => {})
    }
  }, [repoListEnsureLoaded, tasksSupported])

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
          setCreateTeamId((current) =>
            current && teams.some((team) => team.id === current) ? current : (teams[0]?.id ?? null)
          )
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

  const linearMetadataKey = linearMetadataItem?.key ?? null
  useEffect(() => {
    setLinearSubIssueTitle('')
  }, [linearMetadataKey])

  useEffect(() => {
    if (!tasksSupported || !linearMetadataItem || !client) {
      setLinearStates([])
      return
    }
    let stale = false
    setLinearStatesLoading(true)
    setLinearStatesError('')
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
        if (!accepted.accepted) {
          setLinearStatesError(statesLoadFailed())
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearStates([])
          setLinearStatesError(statesLoadFailed())
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
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItemReplyDrafts,
    setItemReviewersDraft,
    setItemTitleDraft,
    setPrFileCommentDrafts
  } = model
  const actionIdentity = actionItem && taskItemIdentity(actionItem)

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

  // Keyed on identity: status edits, refreshes and reconnects hand over a new object for the same item.
  // The comment box is not reset: it is kept per item in its draft row.
  useEffect(() => {
    setItemTitleDraft(actionItem?.title ?? '')
    setItemBodyDraft('')
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
  }, [actionIdentity])
}

// A failed read must not read as a team with no states.
function statesLoadFailed(): string {
  return translate('tasks.filterPickers.statesFailed', "Couldn't load states. Reopen to try again.")
}
