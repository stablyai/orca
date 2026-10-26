import { OrcaRuntimeWithListManagedWorktrees } from './managed-workspace-operations'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import {
  navigationTargetsClients,
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../shared/runtime-navigation'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { phoneWakeReport } from '../../../shared/workspace-sleep'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from '../runtime-worktree-agent-startup'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  resolveWorktreeStartupDraftAgent
} from '../runtime-worktree-agent-startup'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeLineageResolution } from '../runtime-worktree-lineage-resolution'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../../shared/worktree/lineage-types'
import { recordCreatedWorktreeLineage as recordCreatedWorktreeLineageState } from '../runtime-worktree-lineage-recording'
import {
  deliverStartupFollowupPrompt,
  pasteWorktreeStartupDraftWhenReady,
  waitForWorktreeStartupDraft,
  type WorktreeStartupReadinessHost
} from '../runtime-worktree-startup-readiness'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from '../runtime-worktree-terminal-provisioning'
import { readFreshComposerHold } from '../launched-agent-composer-readiness'
import { buildTerminalWaitText } from '../terminal-wait-tail-state'
import {
  describeLaunchedAgentHost,
  readLaunchedAgentForeground,
  type LaunchedAgentForeground,
  type LaunchedAgentHost
} from '../launched-agent-foreground'
import { worktreeRowTarget } from '../../persistence/host-qualified-worktree-meta'

export abstract class OrcaRuntimeWithActivateManagedWorktree extends OrcaRuntimeWithListManagedWorktrees {
  protected abstract toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined
  protected abstract getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost
  protected abstract getWorktreeTerminalProvisioningHost(
    createdWorktree?: Worktree
  ): WorktreeTerminalProvisioningHost

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
    /** unsupported-headless means no renderer holds wake records; clients must not claim agents resumed. */
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }> {
    this.assertGraphReady()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    const navigation = resolveRuntimeNavigationTarget({ ...opts, defaultTarget: 'host' })
    const targetsHost = navigationTargetsHost(navigation)
    const targetsClients = navigationTargetsClients(navigation)

    const target = this.store ? worktreeRowTarget(this.store, worktree) : undefined
    if (
      !targetsHost &&
      target &&
      this.store?.getWorktreeMetaForHost?.(target.id, target.hostId)?.isUnread
    ) {
      // Mobile/web activation bypasses renderer selection, so main must acknowledge unread state.
      this.store.setWorktreeMeta(target, { isUnread: false })
      this.notifyWorktreesChanged(repo.id)
    }

    let sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable' =
      'not-applicable'
    if (targetsHost || targetsClients) {
      // Inactive renderer-owned panes may need desktop activation to gain PTYs.
      if (targetsHost) {
        this.notifyHostActivateWorktree(repo.id, worktree.id)
      }
      if (targetsClients) {
        this.notifyClientsActivateWorktree(repo.id, worktree.id, undefined, navigation)
      }
    }
    if (!targetsHost) {
      // Refresh phone surfaces without navigating attached desktops.
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
        allowAttachedWindow: true
      })
      await this.refreshMobileSessionPtyRecords()
      this.notifyMobileSessionTabsChanged(worktree.id)
      // Why: main resumes a workspace sleep's agents; only a window wakes its own hibernation.
      if (opts.clientKind === 'mobile') {
        // Not awaited: behind a running sleep it would outlast the phone's request timeout.
        const worktreeId = worktree.id
        void this.queueSleepingAgentWake(worktreeId)
        // Wake records live in the repo host's partition, including SSH.
        const records = this.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
        sleepingAgentWake = phoneWakeReport(
          records?.sleepingAgentSessionsByPaneKey,
          worktreeId,
          Boolean(this.getAvailableAuthoritativeWindow())
        )
      }
    }
    return { repoId: repo.id, worktreeId: worktree.id, activated: true, sleepingAgentWake }
  }

  /** Use buildStartupForDraft's selection so launches can name the agent before creation. */
  async resolveStartupDraftAgent(repo: Repo, requestedAgent?: TuiAgent): Promise<TuiAgent | null> {
    if (!this.store) {
      return null
    }
    return resolveWorktreeStartupDraftAgent({
      repo,
      settings: this.store.getSettings(),
      ...(requestedAgent ? { requestedAgent } : {})
    })
  }

  protected async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ): ReturnType<typeof buildWorktreeStartupForDraft> {
    if (!this.store) {
      return null
    }
    return buildWorktreeStartupForDraft({
      repo,
      draft,
      ...(requestedAgent ? { requestedAgent } : {}),
      ...(launchSource ? { launchSource } : {}),
      settings: this.store.getSettings(),
      getLaunchRuntime: (agent) => this.resolveStartupAgentLaunchRuntime(repo, agent)
    })
  }

  protected buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences,
    launchInputs?: {
      agentArgs?: string | null
      extraAgentArgs?: string
      suppressStartupUpdatePrompt?: boolean
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
      /** The existing workspace it starts in; absent is a new workspace of `repo`. */
      launchScope?: TerminalWorkspaceLaunchScope
    }
  ): ReturnType<typeof buildWorktreeStartupForAgent> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return buildWorktreeStartupForAgent({
      repo,
      agent,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      ...(launchInputs?.agentArgs !== undefined ? { agentArgs: launchInputs.agentArgs } : {}),
      ...(launchInputs?.extraAgentArgs ? { extraAgentArgs: launchInputs.extraAgentArgs } : {}),
      ...(launchInputs?.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {}),
      ...(launchInputs?.launchSource ? { launchSource: launchInputs.launchSource } : {}),
      ...(launchInputs?.onPromptCarry ? { onPromptCarry: launchInputs.onPromptCarry } : {}),
      settings: this.store.getSettings(),
      getLaunchRuntime: (agent) =>
        this.resolveStartupAgentLaunchRuntime(repo, agent, launchInputs?.launchScope),
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

  /** Before first input only: await composer readiness without startup dialogs or Codex provisional headers. stopOnDialog returns early for the caller's idle report. */
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
  readLaunchedAgentForeground(ptyId: string, agent: TuiAgent): Promise<LaunchedAgentForeground> {
    const host = this.launchedAgentHost(ptyId)
    return readLaunchedAgentForeground(this.ptyController, host, ptyId, agent)
  }

  /** Whether the pane's execution host can find a launched agent in front: a Windows one cannot. */
  launchedAgentHostProvesAgent(ptyId: string): boolean {
    return !this.launchedAgentHost(ptyId).windows
  }

  launchedAgentHostProvesShellAlone(ptyId: string): boolean {
    return this.launchedAgentHost(ptyId).shellAloneProvable
  }

  private launchedAgentHost(ptyId: string): LaunchedAgentHost {
    const pty = this.ptysById.get(ptyId)
    return describeLaunchedAgentHost(pty, () => this.pathFlavorForPty(pty))
  }

  protected sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void {
    void this.deliverStartupFollowup(handle, followup)
  }

  deliverStartupFollowup(
    handle: string,
    followup: WorktreeStartupFollowup,
    options?: { signal?: AbortSignal; agentLaunch?: boolean }
  ): Promise<boolean> {
    const host = this.getWorktreeStartupReadinessHost()
    return deliverStartupFollowupPrompt(this, host, handle, followup, options)
  }

  async provisionManagedWorktreeTerminals(
    args: {
      worktreeSelector: string
      worktreeId: string
      worktreePath: string
      setup?: CreateWorktreeResult['setup']
      defaultTabs?: CreateWorktreeResult['defaultTabs']
      primaryTerminalHandle?: string | null
      hasStartupTerminal: boolean
      setupOnly?: boolean
      setupCommandPlatform: 'windows' | 'posix'
      observeSetupCompletion?: boolean
      // Pass the setup wrapper that the agent awaits; a bare runner would execute a different script.
      wrappedSetupCommand?: string
      // Background provisioning must not move the user's sidebar selection.
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
