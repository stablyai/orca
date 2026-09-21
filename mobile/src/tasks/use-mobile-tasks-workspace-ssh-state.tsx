import type { WorkspaceSparseActionsModel } from './use-mobile-tasks-workspace-sparse-actions'
import {
  type SshConnectionState,
  normalizeSetupHookTrust,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  useCallback,
  useEffect,
  useMemo
} from './mobile-tasks-dependencies'
import {
  type RepoHooksResponse,
  type RepoSummary,
  type SetupDecision,
  isSuccess
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksWorkspaceSshState(model: WorkspaceSparseActionsModel) {
  const {
    client,
    runtimeTaskSettings,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceDetectedAgentIds,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
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
    if (!client || !tasksSupported || !workspaceCreateTargetConnectionId) {
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
      const response = await client.sendRequest(
        'ssh.connect',
        { targetId: workspaceCreateTargetConnectionId },
        { timeoutMs: 120_000 }
      )
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const state = (response.result as { state?: SshConnectionState | null }).state
      setWorkspaceSshState(
        state ?? {
          targetId: workspaceCreateTargetConnectionId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        }
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
  }, [client, tasksSupported, workspaceCreateTargetConnectionId])

  const ensureWorkspaceSshReady = useCallback(
    async (repo: RepoSummary): Promise<void> => {
      if (!repo.connectionId || !client || !tasksSupported) {
        return
      }
      if (
        workspaceSshState?.targetId === repo.connectionId &&
        workspaceSshState.status === 'connected'
      ) {
        return
      }
      const response = await client.sendRequest('ssh.getState', { targetId: repo.connectionId })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const state = (response.result as { state?: SshConnectionState | null }).state ?? null
      if (state) {
        setWorkspaceSshState(state)
      }
      if (state?.status !== 'connected') {
        throw new Error(`Connect ${repo.displayName} before creating a workspace.`)
      }
    },
    [client, tasksSupported, workspaceSshState]
  )

  useEffect(() => {
    if (!tasksSupported || !workspaceCreateDraft || !client || !workspaceCreateTargetRepo) {
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
    const request = workspaceCreateTargetRepo.connectionId
      ? client.sendRequest('preflight.detectRemoteAgents', {
          connectionId: workspaceCreateTargetRepo.connectionId
        })
      : client.sendRequest('preflight.detectAgents')
    void request
      .then((response) => {
        if (stale) {
          return
        }
        setWorkspaceDetectedAgentIds(
          isSuccess(response) ? new Set(response.result as string[]) : new Set()
        )
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
    client,
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
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setWorkspaceAgent(workspaceAgentSelection.agent)
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
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
      if (!client || !tasksSupported) {
        return { kind: 'decision', decision: override ?? 'inherit' }
      }
      const response = await client.sendRequest('repo.hooks', { repo: `id:${repo.id}` })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as RepoHooksResponse
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
    [client, tasksSupported]
  )
  return Object.assign(model, {
    connectWorkspaceSshRepo,
    ensureWorkspaceSshReady,
    workspaceAgentSelection,
    resolvedWorkspaceAgent,
    workspaceAgentDetectionPending,
    resolveCreateSetupDecision
  })
}

export type WorkspaceSshStateModel = ReturnType<typeof useMobileTasksWorkspaceSshState>
