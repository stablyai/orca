import { randomUUID } from 'node:crypto'
import type { AiVaultChatForkSource } from '../../../../shared/ai-vault-resume-preparation'
import {
  buildAiVaultLocalResumeStartup,
  getAiVaultResumeCodexHome
} from '../../../../shared/ai-vault-resume-startup'
import { agentLaunchQuotingShell } from '../../../../shared/agent-launch-runtime'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { MobileTerminalCommand } from '../../terminal/launch/mobile-terminal-startup'
import { canonicalizeAgentSessionIdentity } from '../../agent-session/ownership/agent-session-claim-identity'
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './get-agent-session-execution-namespace'

export type SwitchTerminalSpawn = {
  agent: TuiAgent
  /** The chat's saved transcript; absent for a chat that never saved a turn. */
  source?: AiVaultChatForkSource
  commandOverride?: string
  options?: Record<string, string>
  signal?: AbortSignal
  /** The execution owner's answer the admission already took, so the spawn carries the same claim. */
  resumeSupported?: boolean
}

export abstract class OrcaRuntimeWithSpawnSwitchTerminal extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  protected abstract resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: { agent: TuiAgent; commandOverride?: string; sessionOptions?: Record<string, string> }
  ): Promise<MobileTerminalCommand>

  /**
   * A switch's terminal: main's ordinary claim-carrying create, parked with no tab until the
   * layout replace shows it. Re-issuing the same create after a lost reply adopts the running
   * terminal through the conversation's claim (the common pattern: an idempotent keyed create),
   * joins an in-flight one, or creates; no custody is owed anywhere.
   */
  async spawnSwitchTerminal(
    workspaceId: string,
    args: SwitchTerminalSpawn
  ): Promise<RuntimeTerminalCreate> {
    const { workspace, launchRuntime, startup, providerSession } = await this.switchTerminalLaunch(
      workspaceId,
      args
    )
    // No claim when nothing can adopt by one: a chat that never saved a turn (no provider session
    // to name), a route that cannot attest one (SSH), or an execution owner too old to adopt. A
    // retry after a lost reply there starts a second CLI, which the user can close.
    const claim =
      providerSession &&
      (args.resumeSupported ??
        (await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', args.signal)))
        ? this.switchTerminalClaim(workspace, args.agent, providerSession)
        : undefined
    if (args.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    return this.createTerminal(`id:${workspace.id}`, {
      wslUserAct: true,
      command: startup.command,
      env: startup.env,
      envToDelete: startup.envToDelete,
      launchConfig: startup.launchConfig,
      startupCommandDelivery:
        'startupCommandDelivery' in startup ? startup.startupCommandDelivery : undefined,
      launchAgent: args.agent,
      launchRuntime,
      ...(providerSession ? { resumeProviderSession: providerSession } : {}),
      resumeOrigin: 'switch',
      presentation: 'background',
      tabId: randomUUID(),
      leafId: randomUUID(),
      ...(claim ? { agentSessionClaim: claim } : {}),
      persistHostSessionBinding: true,
      deferMobileSessionPublish: true,
      signal: args.signal
    })
  }

  /**
   * What a re-issued switch's create would adopt, asked of the registry that create adopts from:
   * the live owner of this conversation's claim in this worktree's scope, only when the create will
   * carry the claim. A first attempt whose answer was lost leaves that terminal for this retry.
   * `resumeSupported` is the execution owner's one answer, which the spawn then reuses.
   */
  async switchTerminalAdoption(
    workspaceId: string,
    args: SwitchTerminalSpawn
  ): Promise<{ resumeSupported?: boolean; ownerPaneKey?: string }> {
    const { workspace, providerSession } = args.source
      ? await this.switchTerminalLaunch(workspaceId, args)
      : {}
    if (!workspace || !providerSession) {
      return {}
    }
    const resumeSupported = await this.executionOwnerSupportsAgentSessionOperation(
      workspace,
      'resume',
      args.signal
    )
    const claim = resumeSupported
      ? this.switchTerminalClaim(workspace, args.agent, providerSession)
      : undefined
    const owner = claim ? this.ptyController?.findAgentSessionOwner?.(claim) : null
    return {
      resumeSupported,
      ...(owner ? { ownerPaneKey: `${owner.surface.tabId}:${owner.surface.leafId}` } : {})
    }
  }

  private async switchTerminalLaunch(workspaceId: string, args: SwitchTerminalSpawn) {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${workspaceId}`,
      undefined,
      {
        wslUserAct: true
      }
    )
    const launchRuntime = this.resolveAgentLaunchRuntime(workspace, args.agent)
    const startup = args.source
      ? buildAiVaultLocalResumeStartup({
          session: args.source,
          settings: this.store?.getSettings(),
          commandOverride: args.commandOverride,
          host: {
            platform: launchRuntime.platform,
            liveShell: agentLaunchQuotingShell(launchRuntime),
            codexHome: getAiVaultResumeCodexHome(args.source.codexHome, launchRuntime.platform)
          },
          embedCwd: false
        })
      : await this.resolveMobileSessionTerminalCommand(workspace, {
          agent: args.agent,
          commandOverride: args.commandOverride,
          sessionOptions: args.options
        })
    const providerSession = 'providerSession' in startup ? startup.providerSession : undefined
    return { workspace, launchRuntime, startup, providerSession }
  }

  private switchTerminalClaim(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent,
    providerSession: AgentProviderSessionMetadata
  ) {
    const namespace = this.getAgentSessionExecutionNamespace(workspace, agent)
    return namespace
      ? this.agentSessionClaimSigner.createClaim({
          namespace,
          identity: canonicalizeAgentSessionIdentity(agent, providerSession),
          canonicalWorktreeId: workspace.id
        })
      : undefined
  }

  /**
   * A switch's terminal that no tab will show once the switch failed with its client connected:
   * ended only while it is still that exact process and nothing views it. Refused or unreachable,
   * it stays for a retry's create to adopt through the claim; one it adopted was never its own.
   */
  async discardSwitchTerminal(terminal: RuntimeTerminalCreate): Promise<void> {
    const pty = terminal.ptyId ? this.ptysById.get(terminal.ptyId) : undefined
    if (
      !pty?.incarnationId ||
      terminal.agentSessionDisposition === 'adopted' ||
      this.hasTerminalViewer(pty.ptyId)
    ) {
      return
    }
    // Main attaches what it spawns, so the viewer check is main's own, as for a window's fenced kill.
    await this.ptyController
      ?.killFenced?.({
        id: pty.ptyId,
        expectedIncarnationId: pty.incarnationId,
        requireNoAgentOwner: false,
        requireUnattached: false
      })
      .catch(() => undefined)
  }
}
