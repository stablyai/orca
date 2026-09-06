import type { ProjectRepositoryResolutionModel } from './use-mobile-tasks-project-repository-resolution'
import {
  type GitHubProjectSettings,
  type TaskProvider,
  useCallback,
  useLayoutEffect,
  useState
} from './mobile-tasks-dependencies'
import type { GitHubPreset, RepoSummary, TaskResumeState } from './mobile-tasks-model'

export function useMobileTasksClientSettingsActions(model: ProjectRepositoryResolutionModel) {
  const {
    defaultRepoSelectionRef,
    githubProjectFieldVisibilityScope,
    repoSelectionHydratedRef,
    setDefaultGitHubPreset,
    setGithubCurrentPage,
    setGithubPages,
    setGithubProjectHiddenFieldIdsByView,
    setGithubProjectSettings,
    setGithubRepoSlugCache,
    setGithubRepoSources,
    setGithubSourceErrors,
    setGithubSourceFallbacks,
    setGithubTotalCount,
    setItems,
    setOrcaYamlTrustPrompt,
    setSetupPrompt,
    setShowWorkspaceAdvanced,
    setShowWorkspaceAgentPicker,
    setShowWorkspaceBaseBranchPicker,
    setShowWorkspaceCreateRepoPicker,
    setShowWorkspaceSparsePicker,
    setTrustedOrcaHooks,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceBaseBranch,
    setWorkspaceBaseBranchError,
    setWorkspaceBaseBranchLoading,
    setWorkspaceBaseBranchQuery,
    setWorkspaceBaseBranchResults,
    setWorkspaceBranchAutoName,
    setWorkspaceBranchNameOverride,
    setWorkspaceCreateDraft,
    setWorkspaceDetectedAgentIds,
    setWorkspaceLastAutoName,
    setWorkspaceNameDraft,
    setWorkspaceRepoPickerItem,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparsePresetsLoading,
    setWorkspaceSparseReloadKey,
    setWorkspaceSparseSaving,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
    taskListOperations,
    taskListOperationsRef,
    taskPreferenceOperations,
    taskReadOperations,
    taskResumeRef,
    taskUiReady,
    trustedOrcaHooks
  } = model
  const resetGitHubItemsState = useCallback(() => {
    setGithubRepoSources({})
    setGithubPages([])
    setGithubCurrentPage(0)
    setGithubTotalCount(null)
    setGithubSourceErrors([])
    setGithubSourceFallbacks([])
  }, [])
  const [boundReadOperations, setBoundReadOperations] = useState(taskReadOperations)
  if (boundReadOperations !== taskReadOperations) {
    setBoundReadOperations(taskReadOperations)
    setItems([])
    setGithubRepoSlugCache({})
    resetGitHubItemsState()
  }
  useLayoutEffect(() => {
    taskListOperationsRef.current = taskListOperations
  }, [taskListOperations])
  useLayoutEffect(() => {
    repoSelectionHydratedRef.current = false
  }, [taskReadOperations])
  const persistTaskResumeState = useCallback(
    (updates: Partial<TaskResumeState>) => {
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      const next = { ...taskResumeRef.current, ...updates }
      taskResumeRef.current = next
      void taskPreferenceOperations.updateResume(next).catch(() => {
        // Best-effort: desktop treats task resume as a convenience preference.
      })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const toggleGitHubProjectFieldVisibility = useCallback(
    (fieldId: string) => {
      if (!githubProjectFieldVisibilityScope) {
        return
      }
      // Why: two toggles in one batch both read render scope and the first is lost.
      setGithubProjectHiddenFieldIdsByView((current) => {
        const hidden = new Set(current[githubProjectFieldVisibilityScope] ?? [])
        if (hidden.has(fieldId)) {
          hidden.delete(fieldId)
        } else {
          hidden.add(fieldId)
        }
        const next = { ...current }
        if (hidden.size === 0) {
          delete next[githubProjectFieldVisibilityScope]
        } else {
          next[githubProjectFieldVisibilityScope] = [...hidden]
        }
        persistTaskResumeState({ githubProjectHiddenFieldIdsByView: next })
        return next
      })
    },
    [githubProjectFieldVisibilityScope, persistTaskResumeState]
  )
  const persistTaskSource = useCallback(
    (nextProvider: TaskProvider) => {
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      void taskPreferenceOperations
        .updateSettings({ defaultTaskSource: nextProvider })
        .catch(() => {
          // Best-effort: a failed settings write should not block switching views.
        })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const persistRepoSelection = useCallback(
    (selection: Set<string>, allRepos: RepoSummary[]) => {
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      const nextSelection =
        selection.size === 0 || selection.size === allRepos.length ? null : [...selection]
      defaultRepoSelectionRef.current = nextSelection
      void taskPreferenceOperations
        .updateSettings({ defaultRepoSelection: nextSelection })
        .catch(() => {
          // Best-effort: the in-memory repo picker already reflects the change.
        })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const persistDefaultGitHubPreset = useCallback(
    (preset: GitHubPreset) => {
      setDefaultGitHubPreset(preset)
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      void taskPreferenceOperations.updateSettings({ defaultTaskViewPreset: preset }).catch(() => {
        // Best-effort: the current session still uses the selected preset.
      })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const persistGitHubProjectSettings = useCallback(
    (nextSettings: GitHubProjectSettings) => {
      setGithubProjectSettings(nextSettings)
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      void taskPreferenceOperations.updateSettings({ githubProjects: nextSettings }).catch(() => {
        // Best-effort: project selection can still work for the current session.
      })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const persistSetupHookTrust = useCallback(
    async (repoId: string, contentHash: string, alwaysTrust: boolean): Promise<void> => {
      if (!taskPreferenceOperations) {
        return
      }
      const next = await taskPreferenceOperations.persistSetupTrust({
        trust: trustedOrcaHooks,
        repoId,
        contentHash,
        alwaysTrust
      })
      setTrustedOrcaHooks(next)
    },
    [taskPreferenceOperations, trustedOrcaHooks]
  )
  const resetWorkspaceCreateState = useCallback((): void => {
    setWorkspaceRepoPickerItem(null)
    setWorkspaceCreateDraft(null)
    setWorkspaceNameDraft('')
    setWorkspaceLastAutoName('')
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setWorkspaceBaseBranch(null)
    setWorkspaceBaseBranchQuery('')
    setWorkspaceBaseBranchResults([])
    setWorkspaceBaseBranchLoading(false)
    setWorkspaceBaseBranchError('')
    setWorkspaceSparsePresets([])
    setWorkspaceSparsePresetsLoading(false)
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    setWorkspaceSparseReloadKey(0)
    setWorkspaceSparsePresetId(null)
    setWorkspaceSparseDraft(null)
    setWorkspaceSparseSaving(false)
    setWorkspaceAgent(null)
    setWorkspaceAgentOverridden(false)
    setWorkspaceDetectedAgentIds(null)
    setWorkspaceSshState(null)
    setWorkspaceSshConnecting(false)
    setShowWorkspaceAgentPicker(false)
    setShowWorkspaceCreateRepoPicker(false)
    setShowWorkspaceAdvanced(false)
    setShowWorkspaceBaseBranchPicker(false)
    setShowWorkspaceSparsePicker(false)
    setSetupPrompt(null)
    setOrcaYamlTrustPrompt(null)
  }, [])
  return Object.assign(model, {
    boundReadOperations,
    persistDefaultGitHubPreset,
    persistGitHubProjectSettings,
    persistRepoSelection,
    persistSetupHookTrust,
    persistTaskResumeState,
    persistTaskSource,
    resetGitHubItemsState,
    resetWorkspaceCreateState,
    setBoundReadOperations,
    toggleGitHubProjectFieldVisibility
  })
}

export type ClientSettingsActionsModel = ReturnType<typeof useMobileTasksClientSettingsActions>
