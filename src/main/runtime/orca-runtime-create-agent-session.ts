// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './orca-runtime-get-agent-session-execution-namespace'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session-host-authority'
import { createHash } from 'node:crypto'
import {
  AGENT_SESSION_OPERATION_GLOBAL_LIMIT,
  AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT
} from './orca-runtime-core'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type {
  AgentSessionCreateOperation,
  AgentSessionCreateReclaimIdentity
} from './runtime-terminal-contracts'
import {
  deterministicAgentSessionUuid,
  isAgentSessionOperationOutcomeUnknown
} from './runtime-agent-launch-resolution'

export class OrcaRuntimeWithCreateAgentSession extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const now = Date.now()
    const operationTimestamp = parseAgentSessionOperationTimestamp(request.clientOperationId)
    if (
      operationTimestamp === null ||
      operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const callerKey = caller.clientId?.trim() || `trusted-local:${caller.clientKind ?? 'runtime'}`
    const operationKey = `${callerKey}\0${request.clientOperationId}`
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.worktree,
          request.agent,
          request.prompt ?? null,
          request.promptDelivery ?? null,
          request.agentArgs ?? null,
          request.agentArgs === undefined ? 'host-default' : 'client-override',
          request.launchPreferences?.model ?? null,
          request.launchPreferences?.effort ?? null,
          request.launchPreferences?.mode ?? null,
          request.startupCwd ?? null,
          request.presentation ?? null,
          request.placement?.tabId ?? null,
          request.placement?.leafId ?? null,
          request.viewMode ?? null
        ])
      )
      .digest('base64url')
    const existing = this.agentSessionCreateOperations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error('agent_session_operation_conflict')
      }
      let replayed: RuntimeCreateAgentSessionResult
      try {
        replayed = await existing.promise
      } catch (error) {
        const reclaimed = await this.reclaimFencedAgentSessionSpawn(existing.reclaim.identity)
        if (!reclaimed) {
          throw error
        }
        return { terminal: reclaimed, disposition: 'replayed' }
      }
      return { ...replayed, disposition: 'replayed' }
    }
    if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      // Why: once a tombstone could have expired, an unseen replay must never
      // be reinterpreted as permission to start another fresh agent.
      throw new Error('agent_session_operation_expired')
    }
    let callerOperationCount = 0
    const callerPrefix = `${callerKey}\0`
    for (const key of this.agentSessionCreateOperations.keys()) {
      if (key.startsWith(callerPrefix)) {
        callerOperationCount += 1
      }
    }
    if (
      callerOperationCount >= AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT ||
      this.agentSessionCreateOperations.size >= AGENT_SESSION_OPERATION_GLOBAL_LIMIT
    ) {
      // Why: tombstones cannot be evicted early without making an old replay
      // capable of spawning again; reject new IDs until retained entries age out.
      throw new Error('agent_session_operation_capacity')
    }
    let retainReplayFence = false
    const reclaim: AgentSessionCreateOperation['reclaim'] = {}
    const operation = (async (): Promise<RuntimeCreateAgentSessionResult> => {
      // Why: reserve the client operation before any async preflight so concurrent retries cannot
      // both observe an empty ledger and reach the execution owner independently.
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
      if (
        !(await this.executionOwnerSupportsAgentSessionOperation(
          workspace,
          'create',
          caller.signal
        ))
      ) {
        // Why: the exact legacy launch remains client-owned until this pre-spawn check succeeds.
        throw new Error('agent_session_legacy_required')
      }
      const startupCwd = this.resolveWorkspaceTerminalStartupCwd(workspace, request.startupCwd)
      // Why: aliases and object property order are client syntax, not authority;
      // fingerprint the host-resolved fields in one fixed order.
      const resolvedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            workspace.id,
            request.agent,
            request.prompt ?? null,
            request.promptDelivery ?? null,
            request.agentArgs ?? null,
            request.agentArgs === undefined ? 'host-default' : 'client-override',
            request.launchPreferences?.model ?? null,
            request.launchPreferences?.effort ?? null,
            request.launchPreferences?.mode ?? null,
            startupCwd ?? null,
            request.presentation ?? null,
            request.placement?.tabId ?? null,
            request.placement?.leafId ?? null,
            request.viewMode ?? null
          ])
        )
        .digest('base64url')
      const settings = this.store!.getSettings()
      if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
        throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
      }
      const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
      // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
      // shape must match the PTY route this scope already resolved.
      const isRemote = Boolean(workspace.connectionId)
      const shell = resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote,
        terminalWindowsShell: settings.terminalWindowsShell
      })
      const startupArgs = {
        agent: request.agent,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentArgs:
          request.agentArgs !== undefined
            ? request.agentArgs
            : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
        sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
        platform,
        shell,
        isRemote
      }
      const startup =
        request.promptDelivery === 'draft'
          ? buildAgentDraftLaunchPlan({ ...startupArgs, draft: request.prompt ?? '' })
          : buildAgentStartupPlan({
              ...startupArgs,
              prompt: request.prompt ?? '',
              allowEmptyPromptLaunch: true
            })
      if (!startup) {
        throw new Error('agent_session_identity_required')
      }
      await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
      if (caller.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let terminal: RuntimeTerminalCreate
      const executionOperationId = createHash('sha256')
        .update(this.runtimeId)
        .update('\0')
        .update(operationKey)
        .update('\0')
        .update(resolvedFingerprint)
        .digest('base64url')
      const operationTabId =
        request.placement?.tabId ?? deterministicAgentSessionUuid(`${executionOperationId}:tab`)
      const operationLeafId =
        request.placement?.leafId ?? deterministicAgentSessionUuid(`${executionOperationId}:leaf`)
      const operationHandle = `term_${deterministicAgentSessionUuid(`${executionOperationId}:handle`)}`
      // Why: recorded before dispatch — this handle is exported into the PTY as
      // ORCA_TERMINAL_HANDLE, so it is the only name a lost spawn can be re-found by.
      reclaim.identity = {
        worktreeId: workspace.id,
        connectionId: workspace.connectionId ?? null,
        terminalHandle: operationHandle
      }
      try {
        terminal = await this.createTerminal(`id:${workspace.id}`, {
          command: startup.launchCommand,
          env: startup.env,
          launchConfig: startup.launchConfig,
          launchAgent: request.agent,
          startupCommandDelivery: startup.startupCommandDelivery,
          cwd: startupCwd,
          presentation: request.presentation ?? 'background',
          tabId: operationTabId,
          leafId: operationLeafId,
          preAllocatedHandle: operationHandle,
          viewMode: request.viewMode,
          agentSessionCreateOperationId: executionOperationId,
          signal: caller.signal,
          onPtySpawnCommitted: () => {
            retainReplayFence = true
          }
        })
      } catch (error) {
        if (isAgentSessionOperationOutcomeUnknown(error)) {
          retainReplayFence = true
        }
        throw error
      }
      return { terminal, disposition: 'created' }
    })()
    this.agentSessionCreateOperations.set(operationKey, {
      fingerprint: requestFingerprint,
      promise: operation,
      reclaim
    })
    const expireOperation = (): void => {
      const expiresAt = Math.max(now, operationTimestamp) + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
      const timer = setTimeout(
        () => {
          if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
            this.agentSessionCreateOperations.delete(operationKey)
          }
        },
        Math.max(1, expiresAt - Date.now())
      )
      timer.unref?.()
    }
    try {
      const result = await operation
      expireOperation()
      return result
    } catch (error) {
      if (retainReplayFence) {
        // Why: the first PTY may still be alive; replay the same failure until
        // expiry instead of interpreting a lost outcome as a fresh spawn grant.
        expireOperation()
      } else if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
        this.agentSessionCreateOperations.delete(operationKey)
      }
      throw error
    }
  }

  // Why: the host may still hold the PTY this operation launched. Adoption-only —
  // this never spawns and never kills, so an unreachable or silent host just replays
  // the original failure instead of authorising anything.
  private async reclaimFencedAgentSessionSpawn(
    identity: AgentSessionCreateReclaimIdentity | undefined
  ): Promise<RuntimeTerminalCreate | null> {
    if (!identity) {
      return null
    }
    try {
      return await this.reconcileRemoteTerminalCreate(
        identity.worktreeId,
        identity.terminalHandle,
        identity.connectionId
      )
    } catch {
      // Unverifiable or ambiguous inventory is never evidence the PTY exited.
      return null
    }
  }
}
