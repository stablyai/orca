import type { ProjectMetadataLoadingModel } from './use-mobile-tasks-project-metadata-loading'
import {
  type BaseRefSearchResult,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MobileAgentIcon,
  type PickerOption,
  type TuiAgent,
  type WorkspaceAgentChoice,
  deriveWorkspaceSshGate,
  filterWorkspaceAgents,
  isWorkspaceAgentEnabled,
  parseSparsePresetDirectories,
  resolveComposerBranchSelection,
  useCallback,
  useMemo,
  workspaceAgentLabel
} from './mobile-tasks-dependencies'
import {
  type ActionableTaskItem,
  type RepoSummary,
  taskWorkspaceSuggestedName,
  workspaceAgentIconId
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksWorkspaceCreateProjection(model: ProjectMetadataLoadingModel) {
  const {
    repos,
    runtimeTaskSettings,
    setError,
    setOrcaYamlTrustPrompt,
    setShowWorkspaceAdvanced,
    setShowWorkspaceAgentPicker,
    setShowWorkspaceBaseBranchPicker,
    setShowWorkspaceCreateRepoPicker,
    setShowWorkspaceSparsePicker,
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
    setWorkspaceLastAutoName,
    setWorkspaceNameDraft,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparseReloadKey,
    setWorkspaceSparseSaving,
    workspaceAgent,
    workspaceBranchAutoName,
    workspaceBranchNameOverride,
    workspaceCreateDraft,
    workspaceDetectedAgentIds,
    workspaceLastAutoName,
    workspaceNameDraft,
    workspaceRepos,
    workspaceSparseDraft,
    workspaceSparsePresets,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading,
    workspaceSparseSaving,
    workspaceSshConnecting,
    workspaceSshState
  } = model
  const getWorkspaceTargetRepo = useCallback(
    (item: ActionableTaskItem, repoIdOverride?: string): RepoSummary | null => {
      if (item.provider === 'github' || item.provider === 'gitlab') {
        return repos.find((entry) => entry.id === item.source.repoId) ?? null
      }
      if (repoIdOverride) {
        return workspaceRepos.find((entry) => entry.id === repoIdOverride) ?? null
      }
      return workspaceRepos[0] ?? null
    },
    [repos, workspaceRepos]
  )

  const workspaceCreateTargetRepo = useMemo(
    () =>
      workspaceCreateDraft
        ? getWorkspaceTargetRepo(workspaceCreateDraft.item, workspaceCreateDraft.repoIdOverride)
        : null,
    [getWorkspaceTargetRepo, workspaceCreateDraft]
  )
  const workspaceCreateTargetConnectionId = workspaceCreateTargetRepo?.connectionId ?? null
  const workspaceCreateSshGate = deriveWorkspaceSshGate({
    connectionId: workspaceCreateTargetConnectionId,
    state: workspaceSshState,
    connecting: workspaceSshConnecting
  })
  const workspaceCreateSshStatus = workspaceCreateSshGate.status
  const workspaceCreateRequiresSshConnection = workspaceCreateSshGate.requiresConnection
  const workspaceCreateSshConnectInProgress = workspaceCreateSshGate.connectInProgress
  const workspaceCreateSshError = workspaceCreateSshGate.error
  const workspaceCreateCanPickRepo =
    workspaceCreateDraft?.item.provider === 'linear' && workspaceRepos.length > 1
  const workspaceSparseCheckoutAvailable =
    workspaceCreateTargetRepo != null && !workspaceCreateTargetRepo.connectionId
  const workspaceSparseDraftParsed = useMemo(
    () =>
      workspaceSparseDraft
        ? parseSparsePresetDirectories(workspaceSparseDraft.directoriesText)
        : null,
    [workspaceSparseDraft]
  )
  const workspaceSparseDraftName = workspaceSparseDraft?.name.trim() ?? ''
  const workspaceSparseDraftNameCollision =
    workspaceSparseDraft && workspaceSparseDraftName
      ? (workspaceSparsePresets.find(
          (preset) =>
            preset.id !== workspaceSparseDraft.presetId &&
            preset.name.toLowerCase() === workspaceSparseDraftName.toLowerCase()
        ) ?? null)
      : null
  const workspaceSparseDraftError =
    workspaceSparseDraft && workspaceSparseDraftName.length === 0
      ? 'Name is required.'
      : workspaceSparseDraftName.length > 80
        ? 'Name must be 80 characters or fewer.'
        : workspaceSparseDraftNameCollision
          ? `"${workspaceSparseDraftNameCollision.name}" already exists.`
          : (workspaceSparseDraftParsed?.error ?? null)
  const canSaveWorkspaceSparseDraft =
    workspaceSparseDraft !== null &&
    workspaceCreateTargetRepo !== null &&
    workspaceSparseCheckoutAvailable &&
    workspaceSparsePresetsLoaded &&
    !workspaceSparsePresetsLoading &&
    !workspaceSparseSaving &&
    !workspaceSparseDraftError &&
    workspaceSparseDraftParsed !== null

  const workspaceAgentOptions = useMemo<PickerOption<WorkspaceAgentChoice>[]>(() => {
    const enabledAgents = filterWorkspaceAgents(
      MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
      runtimeTaskSettings.disabledTuiAgents
    )
    const availableAgents =
      workspaceDetectedAgentIds === null
        ? new Set<TuiAgent>(enabledAgents)
        : new Set<TuiAgent>(enabledAgents.filter((agent) => workspaceDetectedAgentIds.has(agent)))
    if (
      workspaceAgent &&
      workspaceAgent !== 'blank' &&
      isWorkspaceAgentEnabled(workspaceAgent, runtimeTaskSettings.disabledTuiAgents) &&
      (workspaceDetectedAgentIds === null || workspaceDetectedAgentIds.has(workspaceAgent))
    ) {
      availableAgents.add(workspaceAgent)
    }
    const agents = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => availableAgents.has(agent))
    return [
      ...agents.map((agent) => ({
        value: agent,
        label: workspaceAgentLabel(agent),
        subtitle: agent,
        renderIcon: () => <MobileAgentIcon agentId={workspaceAgentIconId(agent)} size={18} />
      })),
      {
        value: 'blank' as const,
        label: workspaceAgentLabel('blank'),
        subtitle: 'Open a shell',
        renderIcon: () => <MobileAgentIcon agentId="__blank__" size={18} />
      }
    ]
  }, [runtimeTaskSettings.disabledTuiAgents, workspaceAgent, workspaceDetectedAgentIds])
  const openWorkspaceCreate = useCallback((item: ActionableTaskItem, repoIdOverride?: string) => {
    const suggestedName = taskWorkspaceSuggestedName(item)
    setWorkspaceCreateDraft({ item, ...(repoIdOverride ? { repoIdOverride } : {}) })
    setWorkspaceNameDraft(suggestedName)
    setWorkspaceLastAutoName(suggestedName)
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setWorkspaceBaseBranch(null)
    setWorkspaceBaseBranchQuery('')
    setWorkspaceBaseBranchResults([])
    setWorkspaceBaseBranchLoading(false)
    setWorkspaceBaseBranchError('')
    setWorkspaceSparsePresetId(null)
    setWorkspaceSparsePresets([])
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    setWorkspaceSparseReloadKey(0)
    setWorkspaceSparseDraft(null)
    setWorkspaceSparseSaving(false)
    setWorkspaceAgentOverridden(false)
    setWorkspaceAgent(null)
    setOrcaYamlTrustPrompt(null)
    setShowWorkspaceAgentPicker(false)
    setShowWorkspaceCreateRepoPicker(false)
    setShowWorkspaceAdvanced(false)
    setShowWorkspaceBaseBranchPicker(false)
    setShowWorkspaceSparsePicker(false)
    setError('')
  }, [])

  const handleWorkspaceNameDraftChange = useCallback(
    (nextName: string): void => {
      if (!nextName.trim()) {
        setWorkspaceLastAutoName('')
      } else if (workspaceNameDraft !== workspaceLastAutoName) {
        setWorkspaceLastAutoName('')
      }
      if (workspaceBranchNameOverride && nextName !== workspaceBranchAutoName) {
        setWorkspaceBranchNameOverride(undefined)
        setWorkspaceBranchAutoName('')
      }
      setWorkspaceNameDraft(nextName)
    },
    [
      workspaceBranchAutoName,
      workspaceBranchNameOverride,
      workspaceLastAutoName,
      workspaceNameDraft
    ]
  )

  const selectWorkspaceBaseBranch = useCallback(
    (branch: BaseRefSearchResult): void => {
      const selection = resolveComposerBranchSelection({
        refName: branch.refName,
        localBranchName: branch.localBranchName,
        currentName: workspaceNameDraft,
        lastAutoName: workspaceLastAutoName
      })
      setWorkspaceBaseBranch(branch)
      setWorkspaceBranchAutoName(selection.branchAutoName)
      setWorkspaceBranchNameOverride(selection.branchNameOverride)
      if (selection.name !== undefined && selection.lastAutoName !== undefined) {
        setWorkspaceNameDraft(selection.name)
        setWorkspaceLastAutoName(selection.lastAutoName)
      }
      setShowWorkspaceBaseBranchPicker(false)
    },
    [workspaceLastAutoName, workspaceNameDraft]
  )

  const clearWorkspaceBaseBranch = useCallback((): void => {
    setWorkspaceBaseBranch(null)
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setShowWorkspaceBaseBranchPicker(false)
  }, [])
  return Object.assign(model, {
    getWorkspaceTargetRepo,
    workspaceCreateTargetRepo,
    workspaceCreateTargetConnectionId,
    workspaceCreateSshGate,
    workspaceCreateSshStatus,
    workspaceCreateRequiresSshConnection,
    workspaceCreateSshConnectInProgress,
    workspaceCreateSshError,
    workspaceCreateCanPickRepo,
    workspaceSparseCheckoutAvailable,
    workspaceSparseDraftParsed,
    workspaceSparseDraftName,
    workspaceSparseDraftNameCollision,
    workspaceSparseDraftError,
    canSaveWorkspaceSparseDraft,
    workspaceAgentOptions,
    openWorkspaceCreate,
    handleWorkspaceNameDraftChange,
    selectWorkspaceBaseBranch,
    clearWorkspaceBaseBranch
  })
}

export type WorkspaceCreateProjectionModel = ReturnType<
  typeof useMobileTasksWorkspaceCreateProjection
>
