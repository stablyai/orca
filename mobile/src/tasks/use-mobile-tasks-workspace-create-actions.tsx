import type { WorkspaceSshStateModel } from './use-mobile-tasks-workspace-ssh-state'
import {
  type HostWorkspaceCreationOperations,
  type MobileComposerCreateSelection,
  type WorkspaceAgentChoice,
  isSetupHookTrusted,
  isWorkspaceAgentEnabled,
  pickWorkspaceAgent,
  shouldResolveHostedReviewStartPoint,
  useCallback,
  wasSetupHookPreviouslyApproved
} from './mobile-tasks-dependencies'
import type { ActionableTaskItem, RuntimeTaskSettings, SetupDecision } from './mobile-tasks-model'

export function useMobileTasksWorkspaceCreateActions(model: WorkspaceSshStateModel) {
  const {
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
      if (!taskWorkspaceCreationOperations || !tasksSupported || !taskStateHydrated) {
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
          latestRuntimeTaskSettings =
            (await taskWorkspaceCreationOperations.readRuntimeSettings()) as RuntimeTaskSettings
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
        // A typed name that still matches the generated one stays auto-managed.
        const nameIsAutoManaged =
          !trimmedWorkspaceName || trimmedWorkspaceName === workspaceLastAutoName
        let selection: MobileComposerCreateSelection
        if (item.provider === 'github') {
          const source = item.source
          let prStartPoint:
            | Awaited<ReturnType<HostWorkspaceCreationOperations['resolvePrBase']>>
            | undefined
          if (
            shouldResolveHostedReviewStartPoint({
              type: source.type,
              baseBranchOverride
            })
          ) {
            prStartPoint = await taskWorkspaceCreationOperations.resolvePrBase({
              repoId: source.repoId,
              prNumber: source.number,
              headRefName: source.branchName,
              baseRefName: source.baseRefName,
              isCrossRepository: source.isCrossRepository
            })
          }
          selection = {
            kind: 'work-item',
            item: {
              provider: 'github',
              type: source.type,
              number: source.number,
              title: source.title,
              url: source.url,
              repoId: source.repoId
            },
            baseBranch: baseBranchOverride ?? prStartPoint?.baseBranch,
            compareBaseRef: prStartPoint?.compareBaseRef,
            pushTarget: prStartPoint?.pushTarget,
            branchNameOverride: branchNameOverride ?? prStartPoint?.branchNameOverride
          }
        } else if (item.provider === 'gitlab') {
          const source = item.source
          let mrStartPoint:
            | Awaited<ReturnType<HostWorkspaceCreationOperations['resolveMrBase']>>
            | undefined
          if (
            shouldResolveHostedReviewStartPoint({
              type: source.type,
              baseBranchOverride
            })
          ) {
            mrStartPoint = await taskWorkspaceCreationOperations.resolveMrBase({
              repoId: source.repoId,
              mrIid: source.number,
              sourceBranch: source.branchName,
              targetBranch: source.baseRefName,
              isCrossRepository: source.isCrossRepository
            })
          }
          selection = {
            kind: 'work-item',
            item: {
              provider: 'gitlab',
              type: source.type,
              number: source.number,
              title: source.title,
              url: source.url,
              repoId: source.repoId
            },
            baseBranch: baseBranchOverride ?? mrStartPoint?.baseBranch,
            compareBaseRef: mrStartPoint?.compareBaseRef,
            pushTarget: mrStartPoint?.pushTarget,
            branchNameOverride: branchNameOverride ?? mrStartPoint?.branchNameOverride
          }
        } else {
          selection = {
            kind: 'work-item',
            item: {
              provider: 'linear',
              type: 'issue',
              number: 0,
              title: item.source.title,
              url: item.source.url,
              linearIdentifier: item.source.identifier,
              linearWorkspaceId: item.source.workspaceId
            },
            baseBranch: baseBranchOverride,
            branchNameOverride
          }
        }
        const result = await taskWorkspaceCreationOperations.createWorkspaceFromSource({
          selection,
          targetRepoId: targetRepo.id,
          setupDecision,
          agentChoice: selectedAgent,
          workspaceName: workspaceNameOverride,
          note: comment,
          sparseCheckout: sparseCheckoutOverride,
          nameIsAutoManaged,
          worktreeCreateIdempotency: taskWorkspaceCreationOperations
            .readRuntimeCapabilities()
            .then((capabilities) => capabilities.worktreeCreateIdempotency)
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        setActionItem(null)
        setWorkspaceCreateDraft(null)
        setSetupPrompt(null)
        const name = result.name ?? item.title
        const queryParams = new URLSearchParams({ name, created: '1' })
        if (result.warning) {
          queryParams.set('warning', result.warning)
        }
        router.push(
          `/h/${hostId}/session/${encodeURIComponent(result.worktreeId)}?${queryParams.toString()}`
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create workspace')
      } finally {
        setCreatingKey(null)
      }
    },
    [
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
  return Object.assign(model, {
    createWorkspace
  })
}

export type WorkspaceCreateActionsModel = ReturnType<typeof useMobileTasksWorkspaceCreateActions>
