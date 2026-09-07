import type { ProjectRepositoryResolutionModel } from './use-mobile-tasks-project-repository-resolution'
import {
  type GitHubProjectSettings,
  type TaskProvider,
  trustedOrcaHooksWithSetupApproval,
  useCallback,
  useLayoutEffect,
  useState
} from './mobile-tasks-dependencies'
import {
  type GitHubPreset,
  type RepoSummary,
  type TaskResumeState,
  isSuccess
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksClientSettingsActions(model: ProjectRepositoryResolutionModel) {
  const {
    client,
    clientRef,
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
    taskResumeRef,
    taskUiReady,
    trustedOrcaHooks
  } = model
  // Why: task-loading effects use this as a stale-client guard, so the ref
  // must be current before those passive effects can run after commit.
  const resetGitHubItemsState = useCallback(() => {
    setGithubRepoSources({})
    setGithubPages([])
    setGithubCurrentPage(0)
    setGithubTotalCount(null)
    setGithubSourceErrors([])
    setGithubSourceFallbacks([])
  }, [])

  // Why: Expo reuses this screen for the next host, so an effect reset runs a
  // render too late and the previous host's rows show under the new one. The
  // repo list resets itself; these are the other client-scoped caches.
  const [boundClient, setBoundClient] = useState(client)
  if (boundClient !== client) {
    setBoundClient(client)
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setItems([])
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setGithubRepoSlugCache({})
    resetGitHubItemsState()
  }

  useLayoutEffect(() => {
    clientRef.current = client
    // Why: ref writes belong in the commit phase. Doing this during render would
    // leak out of a concurrent render React later abandons.
    repoSelectionHydratedRef.current = false
  }, [client])

  const persistTaskResumeState = useCallback(
    (updates: Partial<TaskResumeState>) => {
      if (!client || !taskUiReady) {
        return
      }
      const next = { ...taskResumeRef.current, ...updates }
      taskResumeRef.current = next
      void client.sendRequest('ui.set', { taskResumeState: next }).catch(() => {
        // Best-effort: desktop treats task resume as a convenience preference.
      })
    },
    [client, taskUiReady]
  )

  const toggleGitHubProjectFieldVisibility = useCallback(
    (fieldId: string) => {
      if (!githubProjectFieldVisibilityScope) {
        return
      }
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
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { defaultTaskSource: nextProvider }).catch(() => {
        // Best-effort: a failed settings write should not block switching views.
      })
    },
    [client, taskUiReady]
  )

  const persistRepoSelection = useCallback(
    (selection: Set<string>, allRepos: RepoSummary[]) => {
      if (!client || !taskUiReady) {
        return
      }
      const nextSelection =
        selection.size === 0 || selection.size === allRepos.length ? null : [...selection]
      defaultRepoSelectionRef.current = nextSelection
      void client
        .sendRequest('settings.update', { defaultRepoSelection: nextSelection })
        .catch(() => {
          // Best-effort: the in-memory repo picker already reflects the change.
        })
    },
    [client, taskUiReady]
  )

  const persistDefaultGitHubPreset = useCallback(
    (preset: GitHubPreset) => {
      setDefaultGitHubPreset(preset)
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { defaultTaskViewPreset: preset }).catch(() => {
        // Best-effort: the current session still uses the selected preset.
      })
    },
    [client, taskUiReady]
  )

  const persistGitHubProjectSettings = useCallback(
    (nextSettings: GitHubProjectSettings) => {
      setGithubProjectSettings(nextSettings)
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { githubProjects: nextSettings }).catch(() => {
        // Best-effort: project selection can still work for the current session.
      })
    },
    [client, taskUiReady]
  )

  const persistSetupHookTrust = useCallback(
    async (repoId: string, contentHash: string, alwaysTrust: boolean): Promise<void> => {
      if (!client) {
        return
      }
      const next = trustedOrcaHooksWithSetupApproval({
        trust: trustedOrcaHooks,
        repoId,
        contentHash,
        alwaysTrust
      })
      const response = await client.sendRequest('ui.set', { trustedOrcaHooks: next })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      setTrustedOrcaHooks(next)
    },
    [client, trustedOrcaHooks]
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
    resetGitHubItemsState,
    boundClient,
    persistTaskResumeState,
    toggleGitHubProjectFieldVisibility,
    persistTaskSource,
    persistRepoSelection,
    persistDefaultGitHubPreset,
    persistGitHubProjectSettings,
    persistSetupHookTrust,
    resetWorkspaceCreateState
  })
}

export type ClientSettingsActionsModel = ReturnType<typeof useMobileTasksClientSettingsActions>
