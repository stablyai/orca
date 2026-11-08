import type { ProjectRepositoryResolutionModel } from './use-mobile-tasks-project-repository-resolution'
import {
  type GitHubProjectSettings,
  persistSetupHookTrustApproval,
  useCallback,
  useLayoutEffect,
  useState
} from './mobile-tasks-dependencies'
import type { TaskProvider } from '../../../src/shared/work-items/task-providers'
import type { GitHubPreset, RepoSummary, TaskResumeState } from './mobile-tasks-legacy-foundation'
import { taskSettingsWrite, taskUiStateWrite } from './mobile-task-runtime-operations'
import { patchTaskHydration, type TaskHydration } from './task-queries'
import { replaceEqualDeep, useQueryClient } from '@tanstack/react-query'

export function useMobileTasksClientSettingsActions(model: ProjectRepositoryResolutionModel) {
  const {
    client,
    clientRef,
    githubProjectFieldVisibilityScope,
    hostId,
    setDefaultGitHubPreset,
    setGithubCurrentPage,
    setGithubPages,
    setGithubProjectHiddenFieldIdsByView,
    setGithubProjectSettings,
    setGithubRepoSlugCache,
    setGithubRepoSources,
    setGithubSourceErrors,
    setGithubSourceFallbacks,
    setGithubCountedTotalPages,
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
  const queryClient = useQueryClient()
  // Each write also lands in the kept hydration, so the next visit opens where this one left.
  const keepSettings = useCallback(
    (settings: Partial<TaskHydration['settings']>) =>
      patchTaskHydration(queryClient, hostId, (kept) => ({
        ...kept,
        settings: { ...kept.settings, ...settings }
      })),
    [hostId, queryClient]
  )
  const keepUi = useCallback(
    (ui: NonNullable<TaskHydration['ui']>) =>
      patchTaskHydration(queryClient, hostId, (kept) => ({ ...kept, ui: { ...kept.ui, ...ui } })),
    [hostId, queryClient]
  )
  // Commit stale-client guards before task-loading passive effects run.
  const resetGitHubItemsState = useCallback(() => {
    setGithubRepoSources({})
    setGithubPages([])
    setGithubCurrentPage(0)
    setGithubCountedTotalPages(null)
    setGithubSourceErrors([])
    setGithubSourceFallbacks([])
  }, [])

  // Reset reused-screen caches during render; passive resets expose the previous host’s rows for a frame.
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
  }, [client])

  const persistTaskResumeState = useCallback(
    (updates: Partial<TaskResumeState>) => {
      if (!client || !taskUiReady) {
        return
      }
      const next = { ...taskResumeRef.current, ...updates }
      // Restoring a view re-runs its persistence effects; writing back what is already saved could overwrite a newer desktop copy.
      if (replaceEqualDeep(taskResumeRef.current, next) === taskResumeRef.current) {
        return
      }
      taskResumeRef.current = next
      keepUi({ taskResumeState: next })
      void taskUiStateWrite.request(client, { taskResumeState: next }).catch(() => {
        // Task resume persistence is best-effort; keep the current session usable.
      })
    },
    [client, keepUi, taskUiReady]
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
      keepSettings({ defaultTaskSource: nextProvider })
      void taskSettingsWrite.request(client, { defaultTaskSource: nextProvider }).catch(() => {
        // Failed preference persistence must not block a view switch.
      })
    },
    [client, keepSettings, taskUiReady]
  )

  const persistRepoSelection = useCallback(
    (selection: Set<string>, allRepos: RepoSummary[]) => {
      if (!client || !taskUiReady) {
        return
      }
      const nextSelection =
        selection.size === 0 || selection.size === allRepos.length ? null : [...selection]
      keepSettings({ defaultRepoSelection: nextSelection })
      void taskSettingsWrite.request(client, { defaultRepoSelection: nextSelection }).catch(() => {
        // The local repo picker already reflects the choice.
      })
    },
    [client, keepSettings, taskUiReady]
  )

  const persistDefaultGitHubPreset = useCallback(
    (preset: GitHubPreset) => {
      setDefaultGitHubPreset(preset)
      if (!client || !taskUiReady) {
        return
      }
      keepSettings({ defaultTaskViewPreset: preset })
      void taskSettingsWrite.request(client, { defaultTaskViewPreset: preset }).catch(() => {
        // The selected preset remains usable in this session.
      })
    },
    [client, keepSettings, taskUiReady]
  )

  const persistGitHubProjectSettings = useCallback(
    (nextSettings: GitHubProjectSettings) => {
      setGithubProjectSettings(nextSettings)
      if (!client || !taskUiReady) {
        return
      }
      keepSettings({ githubProjects: nextSettings })
      void taskSettingsWrite.request(client, { githubProjects: nextSettings }).catch(() => {
        // Project selection remains usable in this session.
      })
    },
    [client, keepSettings, taskUiReady]
  )

  const persistSetupHookTrust = useCallback(
    async (repoId: string, contentHash: string, alwaysTrust: boolean): Promise<void> => {
      if (!client) {
        return
      }
      const trusted = await persistSetupHookTrustApproval({
        client,
        trust: trustedOrcaHooks,
        repoId,
        contentHash,
        alwaysTrust
      })
      setTrustedOrcaHooks(trusted)
      keepUi({ trustedOrcaHooks: trusted })
    },
    [client, keepUi, trustedOrcaHooks]
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
    keepSettings,
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
