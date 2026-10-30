import { OrcaRuntimeWithResolveWorktreeRemovalTarget } from '../../workspaces/workspace-removal-target'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../../shared/agent-session-host-authority'
import {
  canonicalizeAgentSessionIdentity,
  type ProviderExecutionNamespace
} from '../../agent-session/ownership/agent-session-claim-identity'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-startup'
import { agentLaunchQuotingShell } from '../../../../shared/agent-launch-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { withAgentSessionAccountEnv } from '../../agent-session-account-env'
import { resolveWslHostAgentResumeInputs } from '../../wsl-host-agent-terminal-launch'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'

export abstract class OrcaRuntimeWithGetAgentSessionExecutionNamespace extends OrcaRuntimeWithResolveWorktreeRemovalTarget {
  protected getAgentSessionExecutionNamespace(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent
  ): ProviderExecutionNamespace | null {
    if (workspace.connectionId) {
      // SSH target ids are not execution-namespace proof; keep legacy launches until attested routes can join claims.
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
      // Merging account roots may conflict conservatively but cannot admit two TUIs owning one provider session.
      providerRoot: `profile-default:${agent}`
    }
  }

  protected async executionOwnerSupportsAgentSessionOperation(
    workspace: TerminalWorkspaceLaunchScope,
    operation: 'resume' | 'create',
    signal?: AbortSignal
  ): Promise<boolean> {
    // Unavailable SSH routes are not proof of an old owner; preserve the structured failure.
    const provider = workspace.connectionId ? null : this.getLocalProvider()
    if (!provider) {
      return true
    }
    const probe =
      operation === 'resume'
        ? provider.supportsAgentSessionClaims
        : provider.supportsAgentSessionCreateOperations
    if (!probe) {
      // Local in-process PTYs need no wire negotiation.
      return true
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
    _caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeEnsureAgentSessionResult> {
    if (request.kind === 'automatic') {
      // Legacy renderer sleep records are migration evidence, not host authority.
      throw new Error('agent_session_resume_not_authorized')
    }
    if (
      request.agent === 'opencode' &&
      Object.values(request.launchPreferences ?? {}).some((value) => value !== undefined)
    ) {
      throw new OrchestrationError(
        'capability_unsupported',
        'OpenCode resume preferences are not verified by this execution host.'
      )
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    // An explicit ensure is the caller's own act (automatic is refused above), as its spawn below.
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree, undefined, {
      wslUserAct: true
    })
    const namespace = this.getAgentSessionExecutionNamespace(workspace, request.agent)
    if (
      !namespace ||
      !(await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', _caller.signal))
    ) {
      // Why: the renderer still holds the exact old request and may retry it before any side effect.
      throw new Error('agent_session_legacy_required')
    }
    // Choose SSH compatibility before canonicalizing paths that belong to the execution owner.
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
    const launchRuntime = this.resolveAgentLaunchRuntime(workspace, request.agent)
    const { platform } = launchRuntime
    const shell = agentLaunchQuotingShell(launchRuntime)
    // Use the resolved PTY route, not display repo metadata that may belong to another host.
    const isRemote = Boolean(workspace.connectionId)
    const startup = buildAgentResumeStartupPlan(
      resolveWslHostAgentResumeInputs({
        agent: request.agent,
        providerSession: identity.providerSession,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentArgs:
          request.agentArgs !== undefined
            ? request.agentArgs
            : resolveTuiAgentLaunchArgs(request.agent, settings),
        agentEnv: resolveTuiAgentLaunchEnv(request.agent, settings),
        ompResumeFilePath: request.ompResumeFilePath,
        sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
        sessionOptionsOverrideAgentArgs: Boolean(request.launchPreferences),
        platform,
        shell,
        isRemote
      })
    )
    if (!startup) {
      throw new Error('agent_session_identity_required')
    }
    if (_caller.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const terminal = await this.createTerminal(`id:${workspace.id}`, {
      // Only the agent-session RPC reaches here: the caller's own act.
      wslUserAct: true,
      command: startup.launchCommand,
      env: withAgentSessionAccountEnv(startup.env, request.accountEnv),
      launchConfig: startup.launchConfig,
      startupCommandDelivery: startup.startupCommandDelivery,
      launchAgent: request.agent,
      // Host-built resumes must name their session so readers can address it.
      resumeProviderSession: identity.providerSession,
      ...(request.resumeOrigin ? { resumeOrigin: request.resumeOrigin } : {}),
      terminalImageViewerSupported: _caller.terminalImageViewerSupported,
      launchRuntime,
      terminalKittyKeyboardProtocol: request.terminalKittyKeyboardProtocol,
      presentation: request.presentation ?? 'background',
      tabId: request.placement?.tabId,
      leafId: request.placement?.leafId,
      agentSessionClaim: claim,
      ...(request.spawnIntent ? { spawnIntent: request.spawnIntent } : {}),
      signal: _caller.signal
    })
    return {
      terminal,
      disposition: terminal.agentSessionDisposition ?? 'created'
    }
  }
}
