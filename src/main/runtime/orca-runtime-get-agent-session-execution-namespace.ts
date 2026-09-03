// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveWorktreeRemovalTarget } from './orca-runtime-resolve-worktree-removal-target'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { canonicalizeAgentSessionIdentity } from './agent-session-claim-identity'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'

export class OrcaRuntimeWithGetAgentSessionExecutionNamespace extends OrcaRuntimeWithResolveWorktreeRemovalTarget {
  protected getAgentSessionExecutionNamespace(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent
  ): { machine: string; principal: string; container: string; providerRoot: string } | null {
    if (workspace.connectionId) {
      // Why: SSH target ids are not execution-namespace proof. Preserve the
      // legacy launch until an attested route can safely participate in claims.
      return null
    }
    const wsl = parseWslUncPath(workspace.path)
    const principal =
      typeof process.getuid === 'function'
        ? `uid:${process.getuid()}`
        : `user:${process.env.USERNAME ?? ''}`
    return {
      machine: wsl ? 'wsl-host' : `native:${process.platform}`,
      principal,
      container: wsl ? `wsl:${wsl.distro.toLocaleLowerCase('en-US')}` : 'native',
      // Why: merging account roots is conservative (it may conflict) and can
      // never permit two TUIs to own one provider session.
      providerRoot: `profile-default:${agent}`
    }
  }

  protected async executionOwnerSupportsAgentSessionOperation(
    workspace: TerminalWorkspaceLaunchScope,
    operation: 'resume' | 'create',
    signal?: AbortSignal
  ): Promise<boolean> {
    const provider = workspace.connectionId
      ? this.getSshProviderFn?.(workspace.connectionId)
      : this.getLocalProvider()
    if (!provider) {
      // An unavailable route is not proof of an old owner; preserve the structured failure.
      return true
    }
    const probe =
      operation === 'resume'
        ? provider.supportsAgentSessionClaims
        : provider.supportsAgentSessionCreateOperations
    if (!probe) {
      // Local in-process PTYs need no wire negotiation; unknown SSH providers are legacy.
      return workspace.connectionId === null
    }
    try {
      return (await probe.call(provider, { signal })) === true
    } catch {
      // Why: this read-only check has not launched anything, so the old route remains safe.
      return false
    }
  }

  protected toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined {
    if (!preferences) {
      return undefined
    }
    const options = {
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      ...(preferences.mode ? { mode: preferences.mode } : {})
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  async ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    _caller: RuntimeAgentSessionRpcCaller = {},
    handoffAuthority?: { spawnToken: string; providerRoot: string; sessionId: string }
  ): Promise<RuntimeEnsureAgentSessionResult> {
    if (request.kind === 'automatic') {
      // Legacy renderer sleep records are migration evidence, not host authority.
      throw new Error('agent_session_resume_not_authorized')
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    const resolvedNamespace = this.getAgentSessionExecutionNamespace(workspace, request.agent)
    const namespace =
      resolvedNamespace && handoffAuthority
        ? { ...resolvedNamespace, providerRoot: handoffAuthority.providerRoot }
        : resolvedNamespace
    if (
      !namespace ||
      !(await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', _caller.signal))
    ) {
      // Why: the renderer still holds the exact old request and may retry it before any side effect.
      throw new Error('agent_session_legacy_required')
    }
    // Why: nested SSH paths belong to the execution owner, so compatibility selection must happen before local filesystem canonicalization.
    const identity = canonicalizeAgentSessionIdentity(request.agent, request.providerSession)
    const claim = this.agentSessionClaimSigner.createClaim({
      namespace,
      identity,
      canonicalWorktreeId: workspace.id
    })
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before resuming.')
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
    const startup = buildAgentResumeStartupPlan({
      agent: request.agent,
      providerSession: identity.providerSession,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs:
        request.agentArgs !== undefined
          ? request.agentArgs
          : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
      agentEnv: {
        ...resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
        ...(handoffAuthority && request.agent === 'codex'
          ? { CODEX_HOME: handoffAuthority.providerRoot }
          : handoffAuthority && request.agent === 'claude'
            ? { CLAUDE_CONFIG_DIR: handoffAuthority.providerRoot }
            : {})
      },
      ompResumeFilePath: request.ompResumeFilePath,
      sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
      platform,
      shell,
      isRemote
    })
    if (!startup) {
      throw new Error('agent_session_identity_required')
    }
    await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
    if (_caller.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const terminal = await this.createTerminal(`id:${workspace.id}`, {
      command: startup.launchCommand,
      env: startup.env,
      launchConfig: startup.launchConfig,
      startupCommandDelivery: startup.startupCommandDelivery,
      launchAgent: request.agent,
      presentation: request.presentation ?? 'background',
      tabId: request.placement?.tabId,
      leafId: request.placement?.leafId,
      agentSessionClaim: claim,
      ...(handoffAuthority
        ? {
            launchToken: handoffAuthority.spawnToken,
            structuredAgentSessionId: handoffAuthority.sessionId
          }
        : {}),
      signal: _caller.signal
    })
    return {
      terminal,
      disposition: terminal.agentSessionDisposition ?? 'created'
    }
  }
}
