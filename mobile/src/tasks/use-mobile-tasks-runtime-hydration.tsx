import { settingsRead } from '../transport/settings-read-operations'
import type { ClientSettingsActionsModel } from './use-mobile-tasks-client-settings-actions'
import { jiraConnectionStatusProbe } from './mobile-jira-operations'
import { readJiraConnectionProbeReply } from './jira-mobile-connection'
import { resolveHydratedTaskViewState } from './mobile-tasks-hydrated-view-state'
import {
  taskLinearStatusRead,
  taskPreflightRead,
  taskRuntimeStatusRead,
  taskUiStateRead
} from './mobile-task-runtime-operations'
import {
  MOBILE_TASKS_CAPABILITY,
  type PersistedTrustedOrcaHooks,
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider,
  useEffect
} from './mobile-tasks-dependencies'
import {
  EMPTY_GITHUB_PROJECT_SETTINGS,
  type RuntimeTaskSettings,
  type TaskResumeState
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksRuntimeHydration(model: ClientSettingsActionsModel) {
  const {
    client,
    connState,
    defaultLinearTeamSelectionRef,
    provider,
    requestedTaskSource,
    resetGitHubItemsState,
    resetWorkspaceCreateState,
    setActionItem,
    setAppliedQuery,
    setDefaultGitHubPreset,
    setDetailPayload,
    setError,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setGithubProjectHiddenFieldIdsByView,
    setGithubProjectSettings,
    setGithubProjectTable,
    setItems,
    setLinearConnected,
    setJiraConnection,
    jiraStatusRequestIdRef,
    setJiraFilter,
    setLinearFilter,
    setLinearStatusPickerItem,
    setLinearTeams,
    setLinearWorkspaces,
    setMergeMethodProjectRow,
    setMergeMethodTaskItem,
    setOrcaYamlTrustPrompt,
    setPendingGitHubProjectViewSelection,
    setPendingHostedMerge,
    setPendingHostedStateChange,
    setPendingProjectGitHubMerge,
    setProjectRepoNotInOrca,
    setProjectRowDetail,
    setProjectRowItem,
    setProvider,
    setQuery,
    setRuntimeTaskSettings,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    setShowCreateTargetPicker,
    setShowCreateTask,
    setShowGitHubIssueSourcePicker,
    setShowGitHubKindPicker,
    setShowGitHubPagePicker,
    setShowGitHubPresetPicker,
    setShowGitHubProjectFieldsPicker,
    setShowGitHubProjectPicker,
    setShowGitHubProjectSortPicker,
    setShowGitHubProjectViewPicker,
    setShowGitLabFilterPicker,
    setShowGitLabViewPicker,
    setShowLinearConnect,
    setShowLinearDisplayPicker,
    setShowLinearFilterPicker,
    setShowLinearGroupPicker,
    setShowLinearOrderPicker,
    setShowLinearTeamPicker,
    setShowLinearViewPicker,
    setShowLinearWorkspacePicker,
    setShowProviderPicker,
    setShowRepoPicker,
    setSelectedRepoIds,
    setShowSortPicker,
    setTaskStateHydrated,
    setTasksSupportState,
    setTrustedOrcaHooks,
    setVisibleProviders,
    taskResumeRef,
    visibleProviders
  } = model
  useEffect(() => {
    if (!client || connState !== 'connected') {
      taskResumeRef.current = {}
      setRuntimeTaskSettings({})
      setTrustedOrcaHooks({})
      setOrcaYamlTrustPrompt(null)
      setGithubProjectHiddenFieldIdsByView({})
      setTaskStateHydrated(false)
      setTasksSupportState({ kind: 'unknown', client: null })
      setShowLinearWorkspacePicker(false)
      setShowLinearTeamPicker(false)
      setShowLinearViewPicker(false)
      setShowLinearGroupPicker(false)
      setShowLinearOrderPicker(false)
      setShowLinearDisplayPicker(false)
      setShowLinearConnect(false)
      setShowProviderPicker(false)
      setShowGitHubKindPicker(false)
      setShowGitHubPresetPicker(false)
      setShowGitLabViewPicker(false)
      setShowGitLabFilterPicker(false)
      setShowLinearFilterPicker(false)
      setShowSortPicker(false)
      setShowRepoPicker(false)
      setShowGitHubIssueSourcePicker(false)
      setShowGitHubPagePicker(false)
      setShowGitHubProjectPicker(false)
      setShowGitHubProjectViewPicker(false)
      setShowGitHubProjectSortPicker(false)
      setShowGitHubProjectFieldsPicker(false)
      setPendingGitHubProjectViewSelection(null)
      setActionItem(null)
      setProjectRowItem(null)
      setProjectRepoNotInOrca(null)
      setDetailPayload(null)
      setProjectRowDetail(null)
      setShowCreateTask(false)
      setShowCreateTargetPicker(false)
      setLinearStatusPickerItem(null)
      setPendingHostedMerge(null)
      setPendingProjectGitHubMerge(null)
      setPendingHostedStateChange(null)
      setMergeMethodTaskItem(null)
      setMergeMethodProjectRow(null)
      resetWorkspaceCreateState()
      return
    }

    let stale = false
    setTaskStateHydrated(false)
    setTasksSupportState({ kind: 'unknown', client })
    setShowLinearWorkspacePicker(false)
    setShowLinearTeamPicker(false)
    setShowLinearViewPicker(false)
    setShowLinearGroupPicker(false)
    setShowLinearOrderPicker(false)
    setShowLinearDisplayPicker(false)
    setShowLinearConnect(false)
    setShowProviderPicker(false)
    setShowGitHubKindPicker(false)
    setShowGitHubPresetPicker(false)
    setShowGitLabViewPicker(false)
    setShowGitLabFilterPicker(false)
    setShowLinearFilterPicker(false)
    setShowSortPicker(false)
    setShowRepoPicker(false)
    setShowGitHubIssueSourcePicker(false)
    setShowGitHubPagePicker(false)
    setShowGitHubProjectPicker(false)
    setShowGitHubProjectViewPicker(false)
    setShowGitHubProjectSortPicker(false)
    setShowGitHubProjectFieldsPicker(false)
    setPendingGitHubProjectViewSelection(null)
    setActionItem(null)
    setProjectRowItem(null)
    setProjectRepoNotInOrca(null)
    setDetailPayload(null)
    setProjectRowDetail(null)
    setShowCreateTask(false)
    setShowCreateTargetPicker(false)
    setLinearStatusPickerItem(null)
    setPendingHostedMerge(null)
    setPendingProjectGitHubMerge(null)
    setPendingHostedStateChange(null)
    setMergeMethodTaskItem(null)
    setMergeMethodProjectRow(null)
    resetWorkspaceCreateState()

    const hydrateTaskState = async (): Promise<void> => {
      const statusReply = await taskRuntimeStatusRead.request(client)
      if (stale) {
        return
      }
      // The guard stays between the request and the interpretation: a screen that has moved on
      // must not raise a refusal it no longer owns.
      const status = taskRuntimeStatusRead.interpret(statusReply)
      if (!status.capabilities?.includes(MOBILE_TASKS_CAPABILITY)) {
        // Why: Tasks is additive RPC surface, so old desktop builds can still
        // pair but must not receive the newer task-specific method calls.
        setTasksSupportState({ kind: 'unsupported', client })
        setItems([])
        resetGitHubItemsState()
        setGithubProjectTable(null)
        setShowLinearWorkspacePicker(false)
        setShowLinearTeamPicker(false)
        setShowLinearViewPicker(false)
        setShowLinearGroupPicker(false)
        setShowLinearOrderPicker(false)
        setShowLinearDisplayPicker(false)
        setShowLinearConnect(false)
        setShowProviderPicker(false)
        setShowGitHubKindPicker(false)
        setShowGitHubPresetPicker(false)
        setShowGitLabViewPicker(false)
        setShowGitLabFilterPicker(false)
        setShowLinearFilterPicker(false)
        setShowSortPicker(false)
        setShowRepoPicker(false)
        setShowGitHubIssueSourcePicker(false)
        setShowGitHubPagePicker(false)
        setShowGitHubProjectPicker(false)
        setShowGitHubProjectViewPicker(false)
        setShowGitHubProjectSortPicker(false)
        setShowGitHubProjectFieldsPicker(false)
        setPendingGitHubProjectViewSelection(null)
        setActionItem(null)
        setProjectRowItem(null)
        setProjectRepoNotInOrca(null)
        setDetailPayload(null)
        setProjectRowDetail(null)
        setShowCreateTask(false)
        setShowCreateTargetPicker(false)
        setLinearStatusPickerItem(null)
        setPendingHostedMerge(null)
        setPendingProjectGitHubMerge(null)
        setPendingHostedStateChange(null)
        setMergeMethodTaskItem(null)
        setMergeMethodProjectRow(null)
        resetWorkspaceCreateState()
        setError('Update Orca desktop to use Tasks on mobile.')
        setTaskStateHydrated(false)
        return
      }
      setTasksSupportState({ kind: 'supported', client })
      setError('')
      // Jira is advisory and must not delay the other providers.
      const jiraRequestId = ++jiraStatusRequestIdRef.current
      void jiraConnectionStatusProbe
        .request(client)
        .catch(() => null)
        .then((reply) => {
          if (!stale && jiraStatusRequestIdRef.current === jiraRequestId) {
            setJiraConnection(readJiraConnectionProbeReply(reply))
          }
        })
      // Why raw requests in the group and not startRpcOperation: main's Promise.all rejects as soon
      // as one leg rejects, and interpreting at an all-settled barrier would instead wait for the
      // slowest peer and let a later policy surface a different error.
      const [settingsResponse, uiReply, preflightReply, linearStatusReply] = await Promise.all([
        settingsRead.request(client),
        taskUiStateRead.request(client),
        taskPreflightRead.request(client),
        taskLinearStatusRead.request(client)
      ])
      if (stale) {
        return
      }

      const settingsResult = settingsRead.interpret(settingsResponse)
      const settings = settingsResult.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          ((settingsResult.value ?? {}) as RuntimeTaskSettings)
        : {}
      setRuntimeTaskSettings(settings)
      const uiRead = taskUiStateRead.interpret(uiReply)
      const uiState = uiRead.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema checks the `{ ui }` container and leaves both members `unknown`, because each is forwarded whole and re-read field by field with its own defaults downstream.
          (uiRead.value as
            | {
                taskResumeState?: TaskResumeState
                trustedOrcaHooks?: PersistedTrustedOrcaHooks
              }
            | undefined)
        : null
      setTrustedOrcaHooks(uiState?.trustedOrcaHooks ?? {})
      const resume = uiState?.taskResumeState ?? {}
      taskResumeRef.current = resume
      setGithubProjectHiddenFieldIdsByView(resume.githubProjectHiddenFieldIdsByView ?? {})

      const preflightRead = taskPreflightRead.interpret(preflightReply)
      const preflight = preflightRead.accepted ? preflightRead.value : null
      const linearRead = taskLinearStatusRead.interpret(linearStatusReply)
      const linearStatus = linearRead.accepted ? linearRead.value : null
      const preferredProviders = normalizeVisibleTaskProviders(settings.visibleTaskProviders)
      const linearIsConnected = linearStatus?.connected === true
      const availableProviders = filterAvailableTaskProviders(preferredProviders, {
        gitlabInstalled: preflight?.glab?.installed === true,
        linearConnected: linearIsConnected
      })
      const nextVisibleProviders =
        preferredProviders.includes('linear') && !availableProviders.includes('linear')
          ? [...availableProviders, 'linear' as const]
          : availableProviders
      setLinearConnected(linearIsConnected)
      if (!linearIsConnected) {
        setLinearWorkspaces([])
        setLinearTeams([])
        setSelectedLinearTeamIds(new Set())
        setSelectedLinearWorkspaceId(null)
      }
      // The user's saved choice, kept as is: readers derive what of it is listed now.
      setSelectedRepoIds(new Set(settings.defaultRepoSelection ?? []))
      defaultLinearTeamSelectionRef.current = settings.defaultLinearTeamSelection ?? null
      const view = resolveHydratedTaskViewState({
        settings,
        resume,
        requestedTaskSource,
        visibleProviders: nextVisibleProviders
      })

      setVisibleProviders(nextVisibleProviders)
      setProvider(view.provider)
      setGithubMode(resume.githubMode === 'project' ? 'project' : 'items')
      setDefaultGitHubPreset(view.defaultGithubPreset)
      setGithubPreset(view.githubPreset)
      setGithubKind(view.githubKind)
      setLinearFilter(view.linearFilter)
      setJiraFilter(view.jiraFilter)
      setGithubProjectSettings(settings.githubProjects ?? EMPTY_GITHUB_PROJECT_SETTINGS)
      setQuery(view.query)
      setAppliedQuery(view.appliedQuery)
      setTaskStateHydrated(true)
    }

    void hydrateTaskState().catch((err) => {
      if (stale) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load Tasks settings')
      setTaskStateHydrated(false)
    })

    return () => {
      stale = true
    }
  }, [client, connState, requestedTaskSource, resetWorkspaceCreateState])

  useEffect(() => {
    if (visibleProviders.includes(provider)) {
      return
    }
    setProvider(resolveVisibleTaskProvider(provider, visibleProviders))
  }, [provider, visibleProviders])

  return model
}

export type RuntimeHydrationModel = ReturnType<typeof useMobileTasksRuntimeHydration>
