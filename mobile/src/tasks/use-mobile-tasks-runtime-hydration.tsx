import { settingsRead } from '../transport/settings-read-operations'
import type { ClientSettingsActionsModel } from './use-mobile-tasks-client-settings-actions'
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
  isHostedTaskRepo,
  normalizeVisibleTaskProviders,
  reconcileRepoSelection,
  resolveVisibleTaskProvider,
  useEffect
} from './mobile-tasks-dependencies'
import {
  EMPTY_GITHUB_PROJECT_SETTINGS,
  type RuntimeTaskSettings,
  type TaskResumeState,
  getTaskPresetQuery,
  githubKindFromQuery,
  isTaskProvider,
  normalizeGitHubPreset,
  normalizeLinearFilter,
  scopeGitHubTaskSearch
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksRuntimeHydration(model: ClientSettingsActionsModel) {
  const {
    client,
    connState,
    defaultLinearTeamSelectionRef,
    defaultRepoSelectionRef,
    provider,
    repoList,
    repoSelectionHydratedRef,
    repos,
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
    setSelectedRepoIds,
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
      defaultRepoSelectionRef.current = null
      repoSelectionHydratedRef.current = false
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
      const nextProvider =
        requestedTaskSource && nextVisibleProviders.includes(requestedTaskSource)
          ? requestedTaskSource
          : resolveVisibleTaskProvider(
              isTaskProvider(settings.defaultTaskSource) ? settings.defaultTaskSource : undefined,
              nextVisibleProviders
            )
      const preset =
        resume.githubItemsPreset === null
          ? normalizeGitHubPreset(settings.defaultTaskViewPreset)
          : normalizeGitHubPreset(resume.githubItemsPreset ?? settings.defaultTaskViewPreset)
      const defaultPreset = normalizeGitHubPreset(settings.defaultTaskViewPreset)
      const githubQuery =
        resume.githubItemsPreset === null
          ? (resume.githubItemsQuery ?? '')
          : getTaskPresetQuery(preset)
      const nextLinearFilter = normalizeLinearFilter(resume.linearPreset)
      const nextLinearQuery = resume.linearQuery ?? ''
      defaultRepoSelectionRef.current = settings.defaultRepoSelection ?? null
      defaultLinearTeamSelectionRef.current = settings.defaultLinearTeamSelection ?? null
      const nextQuery =
        nextProvider === 'github' ? githubQuery : nextProvider === 'linear' ? nextLinearQuery : ''
      const nextAppliedQuery =
        nextProvider === 'github'
          ? scopeGitHubTaskSearch(githubQuery, githubKindFromQuery(githubQuery, preset))
          : nextQuery

      setVisibleProviders(nextVisibleProviders)
      setProvider(nextProvider)
      setGithubMode(resume.githubMode === 'project' ? 'project' : 'items')
      setDefaultGitHubPreset(defaultPreset)
      setGithubPreset(preset)
      setGithubKind(githubKindFromQuery(githubQuery, preset))
      setLinearFilter(nextLinearFilter)
      setGithubProjectSettings(settings.githubProjects ?? EMPTY_GITHUB_PROJECT_SETTINGS)
      setQuery(nextQuery)
      setAppliedQuery(nextAppliedQuery)
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

  // Selection follows the list rather than the fetch, so it reconciles the same
  // way no matter which caller triggered the load.
  useEffect(() => {
    if (repoList.state.status !== 'loaded') {
      return
    }
    if (!repoSelectionHydratedRef.current) {
      repoSelectionHydratedRef.current = true
      setSelectedRepoIds(reconcileRepoSelection(repos, defaultRepoSelectionRef.current))
      return
    }
    setSelectedRepoIds((current) => {
      if (current.size === 0) {
        return current
      }
      const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [repoList.state.status, repos])
  return model
}

export type RuntimeHydrationModel = ReturnType<typeof useMobileTasksRuntimeHydration>
