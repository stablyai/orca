import type { WorkspaceSshStateModel } from './use-mobile-tasks-workspace-ssh-state'
import {
  WORKTREE_CREATE_TIMEOUT_MS,
  type WorkspaceAgentChoice,
  buildTaskWorkspaceCreateParams,
  isSetupHookTrusted,
  isWorkspaceAgentEnabled,
  pickWorkspaceAgent,
  shouldResolveHostedReviewStartPoint,
  useCallback,
  wasSetupHookPreviouslyApproved
} from './mobile-tasks-dependencies'
import {
  type ActionableTaskItem,
  type RuntimeTaskSettings,
  type SetupDecision,
  isSuccess
} from './mobile-tasks-legacy-foundation'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'

export function useMobileTasksWorkspaceCreateActions(model: WorkspaceSshStateModel) {
  const {
    client,
    ensureWorkspaceSshReady,
    getWorkspaceTargetRepo,
    hostId,
    resolveCreateSetupDecision,
    router,
    runtimeTaskSettings,
    setActionItem,
    setCreatingKey,
    setError,
    setOrcaYamlTrustPrompt,
    setRuntimeTaskSettings,
    setSetupPrompt,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceCreateDraft,
    taskStateHydrated,
    taskWorkspaceCreationOperations,
    tasksSupported,
    trustedOrcaHooks,
    workspaceDetectedAgentIds,
    workspaceLastAutoName
  } = model
  const createWorkspace = useCallback(
    async (
      item: ActionableTaskItem,
      repoIdOverride?: string,
      setupOverride?: Exclude<SetupDecision, 'inherit'>,
      agentOverride?: WorkspaceAgentChoice,
      workspaceNameOverride?: string,
      noteOverride?: string,
      baseBranchOverride?: string,
      branchNameOverride?: string,
      sparseCheckoutOverride?: { directories: string[]; presetId?: string },
      approvedSetupContentHash?: string
    ): Promise<void> => {
      if (!client || !taskWorkspaceCreationOperations || !tasksSupported || !taskStateHydrated) {
        return
      }
      setCreatingKey(item.key)
      setError('')
      try {
        const targetRepo = getWorkspaceTargetRepo(item, repoIdOverride)
        if (!targetRepo) {
          throw new Error(
            item.provider === 'linear'
              ? 'Add a Git repository before creating a Linear workspace.'
              : 'Repository not found.'
          )
        }
        await ensureWorkspaceSshReady(targetRepo)
        let latestRuntimeTaskSettings = runtimeTaskSettings
        try {
          // This caller committed `{}` for a settings-less answer; the create sheet keeps its
          // previous value instead, so the empty default stays local to this path.
          latestRuntimeTaskSettings =
            ((await taskWorkspaceCreationOperations.readRuntimeSettings()) ??
              {}) as RuntimeTaskSettings
          setRuntimeTaskSettings(latestRuntimeTaskSettings)
        } catch {
          // Best-effort refresh; the runtime still validates agent availability before spawning.
        }
        const selectedAgent =
          agentOverride &&
          (agentOverride === 'blank' ||
            isWorkspaceAgentEnabled(agentOverride, latestRuntimeTaskSettings.disabledTuiAgents))
            ? agentOverride
            : pickWorkspaceAgent(latestRuntimeTaskSettings, workspaceDetectedAgentIds)
        if (
          agentOverride &&
          agentOverride !== 'blank' &&
          !isWorkspaceAgentEnabled(agentOverride, latestRuntimeTaskSettings.disabledTuiAgents)
        ) {
          setWorkspaceAgent(selectedAgent)
          setWorkspaceAgentOverridden(false)
          throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
        }
        const setupResolution = await resolveCreateSetupDecision(targetRepo, setupOverride)
        const comment = noteOverride?.trim()
        if (setupResolution.kind === 'prompt') {
          // Why: desktop does not silently create when a repo policy says setup
          // requires a per-workspace decision. Mobile must ask before create too.
          setSetupPrompt({
            item,
            ...(repoIdOverride ? { repoIdOverride } : {}),
            ...(agentOverride ? { agentOverride } : {}),
            ...(workspaceNameOverride ? { workspaceNameOverride } : {}),
            ...(comment ? { noteOverride: comment } : {}),
            ...(baseBranchOverride ? { baseBranchOverride } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            ...(sparseCheckoutOverride ? { sparseCheckoutOverride } : {}),
            repoName: targetRepo.displayName,
            command: setupResolution.command,
            source: setupResolution.source
          })
          return
        }
        const setupDecision = setupResolution.decision
        if (
          setupDecision === 'run' &&
          setupResolution.setupTrust &&
          setupResolution.setupTrust.contentHash !== approvedSetupContentHash &&
          !isSetupHookTrusted(
            trustedOrcaHooks,
            targetRepo.id,
            setupResolution.setupTrust.contentHash
          )
        ) {
          // Why: desktop prompts before running repo-owned orca.yaml hooks. Mobile
          // stores the same trust hash in persisted UI state so either surface can
          // approve the script version for future workspace creates.
          setSetupPrompt(null)
          setOrcaYamlTrustPrompt({
            item,
            ...(repoIdOverride ? { repoIdOverride } : {}),
            setupOverride: 'run',
            ...(agentOverride ? { agentOverride } : {}),
            ...(workspaceNameOverride ? { workspaceNameOverride } : {}),
            ...(comment ? { noteOverride: comment } : {}),
            ...(baseBranchOverride ? { baseBranchOverride } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            ...(sparseCheckoutOverride ? { sparseCheckoutOverride } : {}),
            repoId: targetRepo.id,
            repoName: targetRepo.displayName,
            scriptContent: setupResolution.setupTrust.scriptContent,
            contentHash: setupResolution.setupTrust.contentHash,
            previouslyApproved: wasSetupHookPreviouslyApproved(trustedOrcaHooks, targetRepo.id)
          })
          return
        }
        const trimmedWorkspaceName = workspaceNameOverride?.trim() ?? ''
        const nameIsAutoManaged =
          !trimmedWorkspaceName || trimmedWorkspaceName === workspaceLastAutoName
        let params: Record<string, unknown>
        if (item.provider === 'github') {
          const source = item.source
          let prStartPoint:
            | Awaited<ReturnType<HostWorkspaceCreationOperations['resolvePrBase']>>
            | undefined
          if (shouldResolveHostedReviewStartPoint({ type: source.type, baseBranchOverride })) {
            prStartPoint = await taskWorkspaceCreationOperations.resolvePrBase({
              repoId: source.repoId,
              prNumber: source.number,
              headRefName: source.branchName,
              isCrossRepository: source.isCrossRepository
            })
          }
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride,
            hostedStartPoint: prStartPoint,
            nameIsAutoManaged
          })
        } else if (item.provider === 'gitlab') {
          const source = item.source
          let mrStartPoint:
            | Awaited<ReturnType<HostWorkspaceCreationOperations['resolveMrBase']>>
            | undefined
          if (shouldResolveHostedReviewStartPoint({ type: source.type, baseBranchOverride })) {
            mrStartPoint = await taskWorkspaceCreationOperations.resolveMrBase({
              repoId: source.repoId,
              mrIid: source.number,
              sourceBranch: source.branchName,
              isCrossRepository: source.isCrossRepository
            })
          }
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride,
            hostedStartPoint: mrStartPoint,
            nameIsAutoManaged
          })
        } else {
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride,
            nameIsAutoManaged
          })
        }
        // Why still inline: the operations seam's create is the composer's source flow, which
        // builds different params and adds name-collision retry. Task-item create keeps its own
        // params builder until that difference is deliberately reconciled.
        const response = await client.sendRequest('worktree.create', params, {
          timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
        })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          worktree: { id: string; displayName?: string }
          warning?: string
        }
        setActionItem(null)
        setWorkspaceCreateDraft(null)
        setSetupPrompt(null)
        const name = result.worktree.displayName ?? item.title
        const queryParams = new URLSearchParams({ name, created: '1' })
        if (result.warning) {
          queryParams.set('warning', result.warning)
        }
        router.push(
          `/h/${hostId}/session/${encodeURIComponent(result.worktree.id)}?${queryParams.toString()}`
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create workspace')
      } finally {
        setCreatingKey(null)
      }
    },
    [
      client,
      ensureWorkspaceSshReady,
      getWorkspaceTargetRepo,
      hostId,
      resolveCreateSetupDecision,
      router,
      runtimeTaskSettings,
      taskStateHydrated,
      taskWorkspaceCreationOperations,
      tasksSupported,
      trustedOrcaHooks,
      workspaceDetectedAgentIds,
      workspaceLastAutoName
    ]
  )
  return Object.assign(model, { createWorkspace })
}

export type WorkspaceCreateActionsModel = ReturnType<typeof useMobileTasksWorkspaceCreateActions>
