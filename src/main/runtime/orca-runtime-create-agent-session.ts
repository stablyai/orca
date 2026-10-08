// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './orca-runtime-get-agent-session-execution-namespace'
import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session-host-authority'
import { createHash } from 'node:crypto'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { buildExecutionHostAgentStartupPlan } from '../opencode/opencode-model-startup-plan'
import { deterministicAgentSessionUuid } from './runtime-agent-launch-resolution'
import {
  createInMemoryAgentSessionCreateLedger,
  executeAgentSessionCreate,
  type PreparedAgentSessionCreate
} from './agent-session-create-execution'
import { toAgentSessionCreateTerminalTarget } from './agent-session-create-terminal-target'
import type { AgentSessionCreateOperation } from './runtime-terminal-contracts'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'

export class OrcaRuntimeWithCreateAgentSession extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  // Why: the create ledger's rows while the record store cannot be opened or written.
  private readonly agentSessionCreateMemoryLedger = createInMemoryAgentSessionCreateLedger()

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
          request.viewMode ?? null,
          ...(request.terminalKittyKeyboardProtocol === true ? ['kitty-keyboard'] : [])
        ])
      )
      .digest('base64url')
    const existing = this.agentSessionCreateOperations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error('agent_session_operation_conflict')
      }
      try {
        return { ...(await existing.promise), disposition: 'replayed' }
      } catch {
        // Why: the first caller's failure (even its own socket's abort) is not this retry's answer;
        // the ledger row is. Terminates: each pass owns an attempt or joins a newer one.
        this.forgetAgentSessionCreateOperation(operationKey, existing)
        return this.createAgentSession(request, caller)
      }
    }
    const entry: AgentSessionCreateOperation = {
      fingerprint: requestFingerprint,
      promise: Promise.resolve().then(() =>
        executeAgentSessionCreate({
          openStore: () => this.openAgentSessionRecordStore(),
          memory: this.agentSessionCreateMemoryLedger,
          callerKey,
          operationId: request.clientOperationId,
          fingerprint: requestFingerprint,
          now,
          prepare: () => this.prepareAgentSessionCreate(request, caller, operationKey),
          reconcile: (target) =>
            this.reconcileRemoteTerminalCreate(
              target.worktreeId,
              target.terminalHandle,
              target.connectionId
            )
        })
      )
    }
    this.agentSessionCreateOperations.set(operationKey, entry)
    try {
      return await entry.promise
    } finally {
      this.forgetAgentSessionCreateOperation(operationKey, entry)
    }
  }

  private forgetAgentSessionCreateOperation(
    operationKey: string,
    entry: AgentSessionCreateOperation
  ): void {
    if (this.agentSessionCreateOperations.get(operationKey) === entry) {
      this.agentSessionCreateOperations.delete(operationKey)
    }
  }

  private async prepareAgentSessionCreate(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller,
    operationKey: string
  ): Promise<PreparedAgentSessionCreate> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    if (
      !(await this.executionOwnerSupportsAgentSessionOperation(workspace, 'create', caller.signal))
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
          request.viewMode ?? null,
          ...(request.terminalKittyKeyboardProtocol === true ? ['kitty-keyboard'] : [])
        ])
      )
      .digest('base64url')
    const settings = this.store!.getSettings()
    if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    const startupArgs = resolveAgentStartupPlanInputs({
      agent: request.agent,
      settings,
      platform: this.getAgentLaunchPlatformForWorkspace(workspace),
      // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
      // shape must match the PTY route this scope already resolved.
      isRemote: Boolean(workspace.connectionId),
      ...(request.agentArgs !== undefined ? { agentArgs: request.agentArgs } : {}),
      sessionOptions: this.toAgentSessionOptions(request.launchPreferences)
    })
    const startup = await buildExecutionHostAgentStartupPlan({
      inputs: startupArgs,
      cwd: startupCwd ?? workspace.path,
      prompt: request.prompt ?? '',
      promptDelivery: request.promptDelivery,
      hostIdentity: this.runtimeId,
      signal: caller.signal
    })
    if (!startup) {
      throw new Error('agent_session_identity_required')
    }
    if (caller.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const executionOperationId = createHash('sha256')
      .update(
        workspace.connectionId
          ? toSshExecutionHostId(workspace.connectionId)
          : LOCAL_EXECUTION_HOST_ID
      )
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
    return {
      target: toAgentSessionCreateTerminalTarget({
        executionOperationId,
        worktreeId: workspace.id,
        connectionId: workspace.connectionId ?? null,
        terminalHandle: operationHandle,
        tabId: operationTabId,
        leafId: operationLeafId
      }),
      launch: (dispatched) =>
        this.createTerminal(`id:${workspace.id}`, {
          command: startup.launchCommand,
          env: startup.env,
          launchConfig: startup.launchConfig,
          launchAgent: request.agent,
          terminalKittyKeyboardProtocol: request.terminalKittyKeyboardProtocol,
          startupCommandDelivery: startup.startupCommandDelivery,
          // A fresh agent this host built; the request has no surface field, so it counts as `unknown`.
          telemetry: agentStartedTelemetry(request.agent, undefined),
          cwd: startupCwd,
          presentation: request.presentation ?? 'background',
          tabId: operationTabId,
          leafId: operationLeafId,
          preAllocatedHandle: operationHandle,
          viewMode: request.viewMode,
          agentSessionCreateOperationId: executionOperationId,
          signal: caller.signal,
          onPtySpawnDispatched: dispatched,
          onPtySpawnCommitted: dispatched
        })
    }
  }
}
