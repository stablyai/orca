import type { WorkspaceSparseActionsModel } from './use-mobile-tasks-workspace-sparse-actions'
import {
  normalizeSetupHookTrust,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  useCallback,
  useEffect,
  useMemo
} from './mobile-tasks-dependencies'
import type { RepoHooksResponse, RepoSummary, SetupDecision } from './mobile-tasks-model'

export function useMobileTasksWorkspaceSshState(model: WorkspaceSparseActionsModel) {
  const {
    runtimeTaskSettings,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceDetectedAgentIds,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
    taskWorkspaceCreationOperations,
    tasksSupported,
    workspaceAgent,
    workspaceAgentOverridden,
    workspaceCreateDraft,
    workspaceCreateRequiresSshConnection,
    workspaceCreateSshStatus,
    workspaceCreateTargetConnectionId,
    workspaceCreateTargetRepo,
    workspaceDetectedAgentIds,
    workspaceSshState
  } = model
  const connectWorkspaceSshRepo = useCallback(async (): Promise<void> => {
    if (!taskWorkspaceCreationOperations || !tasksSupported || !workspaceCreateTargetConnectionId) {
      return
    }
    setWorkspaceSshConnecting(true)
    setWorkspaceSshState({
      targetId: workspaceCreateTargetConnectionId,
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    })
    try {
      setWorkspaceSshState(
        await taskWorkspaceCreationOperations.connectSsh(workspaceCreateTargetConnectionId)
      )
    } catch (err) {
      setWorkspaceSshState({
        targetId: workspaceCreateTargetConnectionId,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to connect to SSH repository.',
        reconnectAttempt: 0
      })
    } finally {
      setWorkspaceSshConnecting(false)
    }
  }, [taskWorkspaceCreationOperations, tasksSupported, workspaceCreateTargetConnectionId])
  const ensureWorkspaceSshReady = useCallback(
    async (repo: RepoSummary): Promise<void> => {
      if (!repo.connectionId || !taskWorkspaceCreationOperations || !tasksSupported) {
        return
      }
      if (
        workspaceSshState?.targetId === repo.connectionId &&
        workspaceSshState.status === 'connected'
      ) {
        return
      }
      const state = await taskWorkspaceCreationOperations.readSshState(repo.connectionId)
      setWorkspaceSshState(state)
      if (state.status !== 'connected') {
        throw new Error(`Connect ${repo.displayName} before creating a workspace.`)
      }
    },
    [taskWorkspaceCreationOperations, tasksSupported, workspaceSshState]
  )
  useEffect(() => {
    if (
      !tasksSupported ||
      !workspaceCreateDraft ||
      !taskWorkspaceCreationOperations ||
      !workspaceCreateTargetRepo
    ) {
      setWorkspaceDetectedAgentIds(null)
      return
    }
    if (workspaceCreateTargetRepo.connectionId && workspaceCreateSshStatus !== 'connected') {
      // Why: remote agent detection runs on the SSH host through the relay; a
      // disconnected repo would fail and cache an empty agent list.
      setWorkspaceDetectedAgentIds(null)
      return
    }
    let stale = false
    setWorkspaceDetectedAgentIds(null)
    void taskWorkspaceCreationOperations
      .detectAgents(workspaceCreateTargetRepo.connectionId ?? null)
      .then((agentIds) => {
        if (stale) {
          return
        }
        setWorkspaceDetectedAgentIds(new Set(agentIds))
      })
      .catch(() => {
        if (!stale) {
          setWorkspaceDetectedAgentIds(new Set())
        }
      })
    return () => {
      stale = true
    }
  }, [
    taskWorkspaceCreationOperations,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateSshStatus,
    workspaceCreateTargetRepo
  ])
  const workspaceAgentSelection = resolveWorkspaceAgentSelection({
    selectionActive: tasksSupported && workspaceCreateDraft !== null,
    settings: runtimeTaskSettings,
    detectedAgentIds: workspaceDetectedAgentIds,
    agent: workspaceAgent,
    overridden: workspaceAgentOverridden
  })
  if (
    workspaceAgentSelection.agent !== workspaceAgent ||
    workspaceAgentSelection.overridden !== workspaceAgentOverridden
  ) {
    // Why: the drawer can open before SSH/local detection settles. Resolve the
    // visible agent before commit so users do not see an unavailable override.
    setWorkspaceAgent(workspaceAgentSelection.agent)
    setWorkspaceAgentOverridden(workspaceAgentSelection.overridden)
  }
  const resolvedWorkspaceAgent = useMemo(
    () => workspaceAgent ?? pickWorkspaceAgent(runtimeTaskSettings, workspaceDetectedAgentIds),
    [runtimeTaskSettings, workspaceAgent, workspaceDetectedAgentIds]
  )
  const workspaceAgentDetectionPending =
    workspaceCreateDraft != null &&
    workspaceCreateTargetRepo != null &&
    !workspaceCreateRequiresSshConnection &&
    workspaceDetectedAgentIds === null
  const resolveCreateSetupDecision = useCallback(
    async (
      repo: RepoSummary,
      override?: Exclude<SetupDecision, 'inherit'>
    ): Promise<
      | { kind: 'decision'; decision: SetupDecision; setupTrust?: RepoHooksResponse['setupTrust'] }
      | {
          kind: 'prompt'
          command: string
          source: string | null
          setupTrust?: RepoHooksResponse['setupTrust']
        }
    > => {
      if (!taskWorkspaceCreationOperations || !tasksSupported) {
        return { kind: 'decision', decision: override ?? 'inherit' }
      }
      const result = await taskWorkspaceCreationOperations.readRepoHooks(repo.id)
      const setupCommand = result.hooks?.scripts?.setup?.trim()
      const setupTrust = normalizeSetupHookTrust(result.setupTrust) ?? undefined
      if (!setupCommand) {
        return { kind: 'decision', decision: 'inherit' }
      }
      if (override) {
        return { kind: 'decision', decision: override, setupTrust }
      }
      const setupRunPolicy = result.setupRunPolicy ?? 'run-by-default'
      if (setupRunPolicy === 'ask') {
        return { kind: 'prompt', command: setupCommand, source: result.source, setupTrust }
      }
      return {
        kind: 'decision',
        decision: setupRunPolicy === 'run-by-default' ? 'run' : 'skip',
        setupTrust
      }
    },
    [taskWorkspaceCreationOperations, tasksSupported]
  )
  return Object.assign(model, {
    connectWorkspaceSshRepo,
    ensureWorkspaceSshReady,
    resolveCreateSetupDecision,
    resolvedWorkspaceAgent,
    workspaceAgentDetectionPending,
    workspaceAgentSelection
  })
}

export type WorkspaceSshStateModel = ReturnType<typeof useMobileTasksWorkspaceSshState>
