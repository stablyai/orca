// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { probeWslLaunchFolderBeforePlanning } from './this-orca-launch-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft
} from './runtime-worktree-agent-startup'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeLineageResolution } from './runtime-worktree-lineage-resolution'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../shared/worktree/lineage-types'
import { recordCreatedWorktreeLineage as recordCreatedWorktreeLineageState } from './runtime-worktree-lineage-recording'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  waitForWorktreeStartupDraft
} from './runtime-worktree-startup-readiness'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { provisionWorktreeTerminals } from './runtime-worktree-terminal-provisioning'
import { readFreshComposerHold } from './launched-agent-composer-readiness'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  asLaunchedAgentForeground,
  readTerminalForegroundVerdict,
  type LaunchedAgentForeground
} from './launched-agent-foreground'
import type { TerminalForegroundVerdict } from './terminal-foreground-group'

export class OrcaRuntimeWithActivateManagedWorktree extends OrcaRuntimeWithListManagedWorktrees {
  async activateManagedWorktree(
    worktreeSelector: string,
    opts: {
      notifyClients?: boolean
      clientKind?: 'mobile' | 'runtime'
      navigation?: RuntimeNavigationTarget
    } = {}
  ): Promise<{
    repoId: string
    worktreeId: string
    activated: boolean
    /** Mobile-scoped slept-agent wake outcome. `unsupported-headless` means no
     *  renderer holds the sleeping records (headless `orca serve`), so nothing
     *  woke — clients must not present the worktree's agents as resumed. */
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }> {
    this.assertGraphReady()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const targetsClients = navigationTargetsClients(navigation)

    if (!targetsHost && this.store?.getWorktreeMeta(worktree.id)?.isUnread) {
      // Why: mobile/web session activation intentionally bypasses renderer
      // selection, so the runtime must acknowledge the unread state itself.
      this.store.setWorktreeMeta(worktree.id, { isUnread: false })
      this.notifyWorktreesChanged(repo.id)
    }

    let sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable' =
      'not-applicable'
    if (targetsHost || targetsClients) {
      // Why: inactive worktree terminal panes are renderer-owned and may not have
      // live PTYs until the desktop activates the worktree and mounts them.
      if (targetsHost) {
        this.notifyHostActivateWorktree(repo.id, worktree.id)
      }
      if (targetsClients) {
        this.notifyClientsActivateWorktree(repo.id, worktree.id)
      }
    }
    if (!targetsHost) {
      // Why: mobile/web selection needs fresh session surfaces without forcing
      // every attached desktop renderer to navigate to the phone's workspace.
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
        allowAttachedWindow: true
      })
      await this.refreshMobileSessionPtyRecords()
      this.notifyMobileSessionTabsChanged(worktree.id)
      // Why: a phone open must also wake the worktree's slept agents (experimental
      // agent sleep). Only the host renderer holds the sleeping records + wake
      // authority, so fire-and-forget ask it — mobile-scoped so web/desktop are
      // unaffected. Headless serve has no renderer to wake anything, so report
      // that explicitly instead of letting mobile assume the agents resumed.
      if (opts.clientKind === 'mobile') {
        if (this.getAvailableAuthoritativeWindow()) {
          this.notifier?.resumeSleepingAgents?.(worktree.id)
          sleepingAgentWake = 'requested'
        } else if (
          // Why: sleeping records are partitioned by execution host; reading
          // only the local partition would miss slept agents on SSH-host
          // worktrees and skip the headless warning for them.
          Object.values(
            this.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
              .sleepingAgentSessionsByPaneKey ?? {}
          ).some((record) => record.worktreeId === worktree.id)
        ) {
          // Why: headless is only degraded when this worktree actually has a
          // persisted resume record. Ordinary mobile activation must not show
          // an unsupported warning merely because no desktop window is open.
          sleepingAgentWake = 'unsupported-headless'
        }
      }
    }
    return { repoId: repo.id, worktreeId: worktree.id, activated: true, sleepingAgentWake }
  }

  protected async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null> {
    if (!this.store) {
      return null
    }
    return buildWorktreeStartupForDraft({
      repo,
      draft,
      ...(requestedAgent ? { requestedAgent } : {}),
      ...(launchSource ? { launchSource } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo)
    })
  }

  protected async buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences,
    launchInputs?: {
      agentArgs?: string | null
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
    }
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    followup?: WorktreeStartupFollowup
  }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    await probeWslLaunchFolderBeforePlanning({
      launchPlatform: this.getAgentLaunchPlatformForRepo(repo),
      isRemote: repoIsRemote(repo),
      workspacePath: repo.path,
      prompt
    })
    return buildWorktreeStartupForAgent({
      repo,
      agent,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      ...(launchInputs?.agentArgs !== undefined ? { agentArgs: launchInputs.agentArgs } : {}),
      ...(launchInputs?.launchSource ? { launchSource: launchInputs.launchSource } : {}),
      ...(launchInputs?.onPromptCarry ? { onPromptCarry: launchInputs.onPromptCarry } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo),
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
  }

  protected recordCreatedWorktreeLineage(
    worktree: Pick<Worktree, 'id' | 'instanceId'>,
    lineageResolution: WorktreeLineageResolution
  ): {
    lineage: WorktreeLineage | null
    workspaceLineage: WorkspaceLineage | null
    warnings: WorktreeLineageWarning[]
  } {
    return recordCreatedWorktreeLineageState(this.store, worktree, lineageResolution)
  }

  protected pasteStartupDraftWhenReady(handle: string, draft: WorktreeStartupDraftPaste): void {
    pasteWorktreeStartupDraftWhenReady(this.getWorktreeStartupReadinessHost(), handle, draft)
  }

  /**
   * Only for a newly launched agent, before its first input. Settles when the agent's composer
   * signal fires on a screen with no startup dialog and no Codex provisional header; with
   * `stopOnDialog`, a dialog ends the wait so the caller's idle wait can report it.
   */
  async waitForFreshWorkerComposer(
    handle: string,
    agent: TuiAgent,
    timeoutMs: number,
    {
      requireComposerMarker = true,
      stopOnDialog = false,
      signal
    }: { requireComposerMarker?: boolean; stopOnDialog?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeTerminalWait> {
    const initialPtyId =
      this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    const stop = new AbortController()
    const onAbort = (): void => stop.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const ptyId = await waitForWorktreeStartupDraft(
      { ...this.getWorktreeStartupReadinessHost(), getPtyId: () => initialPtyId },
      handle,
      agent,
      {
        timeoutMs,
        requireComposerMarker,
        // Every caller pastes and then presses Enter: a worker brief or a launch prompt.
        submit: true,
        signal: stop.signal,
        isShellInFront: async (ownerPtyId) =>
          (await this.readLaunchedAgentForeground(ownerPtyId, agent)) === 'shell',
        accept: (readyPtyId) => {
          const pty = this.ptysById.get(readyPtyId)
          const hold = pty
            ? readFreshComposerHold(
                buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
                this.readLiveTerminalScreenLines(readyPtyId)
              )
            : null
          if (hold === 'dialog' && stopOnDialog) {
            stop.abort()
          }
          return hold === null
        }
      }
    )
    signal?.removeEventListener('abort', onAbort)
    if (!ptyId) {
      throw new Error(
        signal?.aborted
          ? 'request_aborted'
          : stop.signal.aborted
            ? 'agent_startup_dialog'
            : 'timeout'
      )
    }
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    if (!this.ptysById.get(ptyId)?.connected) {
      throw new Error('terminal_handle_stale')
    }
    return this.buildTuiIdleProbeResult(handle, null)
  }

  /** What holds the terminal a launch started its agent in, read fresh from the execution host. */
  async readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground> {
    return asLaunchedAgentForeground(await this.readTerminalForegroundVerdict(ptyId, agent))
  }

  readTerminalForegroundVerdict(
    ptyId: string,
    agent: TuiAgent
  ): Promise<TerminalForegroundVerdict> {
    return readTerminalForegroundVerdict(
      this.ptyController,
      this.launchedAgentHost(ptyId),
      ptyId,
      agent
    )
  }

  /** Whether the pane's execution host can find a launched agent in front: a Windows one cannot. */
  launchedAgentHostProvesAgent(ptyId: string): boolean {
    return !this.launchedAgentHost(ptyId).windows
  }

  private launchedAgentHost(ptyId: string): { remote: boolean; windows: boolean } {
    const pty = this.ptysById.get(ptyId)
    const remote = !!pty?.connectionId
    // A local WSL pane still runs on a Windows host, whose process reads cannot see into it.
    return {
      remote,
      windows: remote ? this.pathFlavorForPty(pty) === 'win32' : process.platform === 'win32'
    }
  }

  protected sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void {
    sendWorktreeStartupFollowupWhenReady(this.getWorktreeStartupReadinessHost(), handle, followup)
  }

  protected async provisionManagedWorktreeTerminals(
    args: {
      worktreeSelector: string
      worktreeId: string
      worktreePath: string
      setup?: CreateWorktreeResult['setup']
      defaultTabs?: CreateWorktreeResult['defaultTabs']
      primaryTerminalHandle?: string | null
      hasStartupTerminal: boolean
      setupCommandPlatform: 'windows' | 'posix'
      observeSetupCompletion?: boolean
      // Why: when the agent startup is sequenced to wait for setup
      // (waitForAgentStartup), the startup PTY runs a wrapper that already embeds
      // the setup command. Pass that wrapped command through so the Setup tab runs
      // the same script the agent is waiting on instead of a bare runner.
      wrappedSetupCommand?: string
      // Why: a workspace provisioned in the background must not pull the sidebar
      // to itself; the user never asked to look at these tabs.
      surfaceOwner?: false
    },
    createdWorktree?: Worktree
  ): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
    return provisionWorktreeTerminals(
      this.getWorktreeTerminalProvisioningHost(createdWorktree),
      args
    )
  }
}
