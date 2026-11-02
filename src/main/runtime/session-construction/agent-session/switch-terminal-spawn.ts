import { randomUUID } from 'node:crypto'
import type { AiVaultChatForkSource } from '../../../../shared/ai-vault-resume-preparation'
import {
  buildAiVaultLocalResumeStartup,
  getAiVaultResumeCodexHome
} from '../../../../shared/ai-vault-resume-startup'
import { agentLaunchQuotingShell } from '../../../../shared/agent-launch-runtime'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { MobileTerminalCommand } from '../../terminal/launch/mobile-terminal-startup'
import { canonicalizeAgentSessionIdentity } from '../../agent-session/ownership/agent-session-claim-identity'
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './get-agent-session-execution-namespace'
import { deterministicAgentSessionUuid } from '../../runtime-agent-launch-resolution'
import { withTimeoutResult } from '../../runtime-async-boundaries'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../orca-runtime-postlude'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

export type SwitchTerminalSpawn = {
  agent: TuiAgent
  /** The chat's saved transcript; absent for a chat that never saved a turn. */
  source?: AiVaultChatForkSource
  commandOverride?: string
  options?: Record<string, string>
  signal?: AbortSignal
  /** The execution owner's answer the admission already took, so the spawn carries the same claim. */
  resumeSupported?: boolean
  /** Another worktree's terminal holds the conversation's claim: open this one without it. */
  unclaimed?: boolean
  /** The chat being switched, whose terminal's create carries its key. */
  chatSessionId: string
}

/** One key per chat's switch terminal: a retry's create names the terminal its lost attempt
 *  started, while that one runs. */
const switchTerminalHandle = (workspaceId: string, chatSessionId: string): string =>
  `term_${deterministicAgentSessionUuid(`switch-terminal\0${workspaceId}\0${chatSessionId}`)}`

/** Another worktree's terminal, or several, own the conversation's claim. The switch checks only
 *  its own tab (Brennan 11-01, temporary): it opens its terminal unclaimed instead of refusing. */
const isClaimHeldElsewhere = (error: unknown): boolean =>
  error instanceof Error && error.message === 'agent_session_conflict'

export abstract class OrcaRuntimeWithSpawnSwitchTerminal extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  protected abstract resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: { agent: TuiAgent; commandOverride?: string; sessionOptions?: Record<string, string> }
  ): Promise<MobileTerminalCommand>

  /**
   * A switch's terminal: main's ordinary claim-carrying create, parked with no tab until the
   * layout replace shows it, keyed by the chat it replaces. A retry after a lost reply first
   * adopts the terminal that key names (`ownSwitchTerminal`), whichever claim either attempt
   * carried (the common pattern: an idempotent keyed create); no custody is owed anywhere.
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
    // to name), a route that cannot attest one (SSH), or an execution owner too old to adopt.
    const claim =
      providerSession &&
      !args.unclaimed &&
      (args.resumeSupported ??
        (await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', args.signal)))
        ? this.switchTerminalClaim(workspace, args.agent, providerSession)
        : undefined
    if (args.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const create = (agentSessionClaim: typeof claim) =>
      this.createTerminal(`id:${workspace.id}`, {
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
        preAllocatedHandle: switchTerminalHandle(workspace.id, args.chatSessionId),
        ...(agentSessionClaim ? { agentSessionClaim } : {}),
        persistHostSessionBinding: true,
        deferMobileSessionPublish: true,
        signal: args.signal
      })
    // A holder that took the claim during the stop: its refusal precedes any spawn.
    return await create(claim).catch((error: unknown) => {
      if (claim && isClaimHeldElsewhere(error)) {
        return create(undefined)
      }
      throw error
    })
  }

  /**
   * The switch's create decided before the chat stops, by the create's own ownership preparation:
   * a refusal it would give after the stop rejects now, and a claim another worktree's terminal
   * holds makes the create unclaimed. `resumeSupported` is the execution owner's one answer, which
   * the spawn then reuses; the spawn still decides again, so nothing here outlives the stop.
   */
  async switchTerminalAdoption(
    workspaceId: string,
    args: SwitchTerminalSpawn
  ): Promise<{ resumeSupported?: boolean; unclaimed?: boolean }> {
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
    try {
      const preparing = claim ? this.ptyController?.prepareAgentSessionOwner?.(claim) : undefined
      if (preparing) {
        // A join waits on another create; the switch's deadline bounds it, as nothing stopped yet.
        await waitForPromiseWithSignal(preparing, args.signal)
      }
    } catch (error) {
      if (isClaimHeldElsewhere(error)) {
        return { resumeSupported, unclaimed: true }
      }
      throw error
    }
    return { resumeSupported }
  }

  /**
   * The switch's own terminal for this chat, started by an attempt whose answer was lost and still
   * running: found by its create's key, so the retry places it instead of starting another CLI.
   * Gone once it exits, so a later switch creates its own. An owner that lists no processes (too
   * old to report the key) finds none, and a retry there starts a second CLI the user can close.
   */
  async ownSwitchTerminal(
    workspaceId: string,
    chatSessionId: string
  ): Promise<RuntimeTerminalCreate | undefined> {
    if (!this.ptyController?.listProcesses) {
      return undefined
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${workspaceId}`,
      undefined,
      {
        wslUserAct: true
      }
    )
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(getConnectionExecutionHostId(workspace.connectionId)),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      // An unread inventory cannot prove the earlier terminal is gone.
      throw new Error('runtime_unavailable')
    }
    const terminalHandle = switchTerminalHandle(workspace.id, chatSessionId)
    const own = listed.value.filter(
      (session) => session.terminalHandle === terminalHandle && !session.exiting
    )
    if (own.length === 0) {
      return undefined
    }
    // The in-process provider lists no pane key; it runs in this process, which then knows the pane.
    const paneKey = own[0].paneKey ?? this.paneOfPty(this.ptysById.get(own[0].id)).paneKey
    if (own.length > 1 || !paneKey?.includes(':')) {
      throw new Error('terminal_create_identity_conflict')
    }
    return {
      ...this.adoptListedTerminal(own[0], workspace.id, terminalHandle),
      tabId: paneKey.slice(0, paneKey.indexOf(':')),
      paneKey,
      agentSessionDisposition: 'adopted'
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
   * it stays for a retry to adopt by its key; one it adopted is not ended here.
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
