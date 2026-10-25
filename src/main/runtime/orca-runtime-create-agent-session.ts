import type { BrowserWindow } from 'electron'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './session-construction/agent-session/get-agent-session-execution-namespace'
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
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type {
  AgentSessionCreateOperation,
  AgentSessionCreateReclaimIdentity
} from './runtime-terminal-contracts'
import {
  deterministicAgentSessionUuid,
  isAgentSessionOperationOutcomeUnknown
} from './runtime-agent-launch-resolution'
import { AgentLaunchUnbuildableError } from './runtime-agent-terminal-startup'

export abstract class OrcaRuntimeWithCreateAgentSession extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  abstract resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined

  protected abstract buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    agentTeamsEnv?: Record<string, string>
  ): Record<string, string>

  abstract getAuthoritativeWindow(missingWindowMessage?: string): BrowserWindow

  abstract waitForTerminalHandle(tabId: string, timeoutMs?: number): Promise<string>

  protected abstract reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string,
    connectionId?: string | null
  ): Promise<RuntimeTerminalCreate | null>

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
      // Expired tombstones must never turn unseen retries into fresh-spawn permission.
      throw new Error('agent_session_operation_expired')
    }
    let retainReplayFence = false
    const reclaim: AgentSessionCreateOperation['reclaim'] = {}
    const operation = (async (): Promise<RuntimeCreateAgentSessionResult> => {
      // Reserve before async preflight so racing retries cannot independently dispatch.
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
      if (
        !(await this.executionOwnerSupportsAgentSessionOperation(
          workspace,
          'create',
          caller.signal
        ))
      ) {
        // Legacy launch remains client-owned until this pre-spawn check passes.
        throw new Error('agent_session_legacy_required')
      }
      const startupCwd = this.resolveWorkspaceTerminalStartupCwd(workspace, request.startupCwd)
      // Fingerprint resolved authority in fixed order; aliases/property order are only client syntax.
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
      // Record before dispatch: ORCA_TERMINAL_HANDLE is the only identity recoverable after a lost spawn.
      reclaim.identity = {
        worktreeId: workspace.id,
        connectionId: workspace.connectionId ?? null,
        terminalHandle: operationHandle
      }
      try {
        terminal = await this.createTerminal(`id:${workspace.id}`, {
          // No requested surface: the host-planned launch uses unknown.
          startupAgent: request.agent,
          ...(request.prompt ? { startupPrompt: request.prompt } : {}),
          startupPromptDelivery: request.promptDelivery,
          // TEMPORARY: see `startupPromptCarry`.
          startupPromptCarry: 'force-line',
          ...(request.agentArgs !== undefined ? { agentArgs: request.agentArgs } : {}),
          launchPreferences: request.launchPreferences,
          // Account env is re-prepared per attempt; exclude from fingerprints and let first spawn win.
          accountEnv: request.accountEnv,
          terminalImageViewerSupported: caller.terminalImageViewerSupported,
          terminalKittyKeyboardProtocol: request.terminalKittyKeyboardProtocol,
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
        if (error instanceof AgentLaunchUnbuildableError) {
          throw new Error('agent_session_identity_required')
        }
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
        // Unknown outcome may hide a live PTY; replay failure until expiry, never grant another spawn.
        expireOperation()
      } else if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
        this.agentSessionCreateOperations.delete(operationKey)
      }
      throw error
    }
  }

  // Adoption only: never spawn/kill during recovery; unreachable or ambiguous hosts replay the original failure.
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
