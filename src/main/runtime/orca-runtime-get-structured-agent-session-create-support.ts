// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { OrcaRuntimeWithGetWorktreePs } from './orca-runtime-get-worktree-ps'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { supportsClaudeStructuredLocation } from '../claude/claude-structured-location-support'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { resolveStructuredAgentSessionCreateSupport } from '../native-chat/structured-agent-session-create-support'
import {
  resolveCommittedStructuredAgentSessionAdoptionIntent,
  resolveStructuredAgentSessionAdoptionForCreate
} from './structured-agent-session-create-adoption'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { runStructuredAgentSessionStartup } from './structured-agent-session-startup-step'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath
} from './structured-agent-account-home'
import { resolveStructuredLaunchSeedOptions } from '../../shared/native-chat-session-option-defaults'
import { hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk } from './structured-agent-session-runtime'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import { StructuredAgentSessionStartupChatWork } from './structured-agent-session-startup-chat-work'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export class OrcaRuntimeWithGetStructuredAgentSessionCreateSupport extends OrcaRuntimeWithGetWorktreePs {
  // Listed chats startup could not answer from stored state; null until it has run.
  protected structuredAgentSessionBackgroundRestoreIds: string[] | null = null
  protected structuredAgentSessionStartupChatWork = new StructuredAgentSessionStartupChatWork()
  protected structuredAgentSessionStartupStepPromise: Promise<void> | null = null
  private readonly structuredAgentSessionStartupLogger = createStructuredAgentSessionLogger()

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'claude' | 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    return resolveStructuredAgentSessionCreateSupport({
      agent,
      location,
      adapterSupportsCreate:
        agent === 'claude'
          ? supportsClaudeStructuredLocation(location)
          : supportsCodexStructuredLocation(location),
      getSettings: () => this.requireStore().getSettings()
    })
  }

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.store?.getRepo(target.worktree.repoId)
    const folderScope = parseWorkspaceKey(target.worktree.id)
    const folderWorkspace = folderScope?.type === 'folder'
    // WSL routing describes *this* machine; no remote or runtime host may inherit
    // it. Both branches key on executionHostId: the target no longer carries a
    // connectionId, which used to spell remote, unresolved and local alike.
    const isLocalHost = target.executionHostId === LOCAL_EXECUTION_HOST_ID
    const configuredWslDistro =
      repo && isLocalHost
        ? (getLocalProjectWorktreeGitOptions(this.requireStore(), repo).wslDistro ?? null)
        : null
    // Folder workspaces have no repo Git options, so a WSL UNC path is the only
    // durable signal that native Windows structured Codex cannot safely use it.
    const wslDistro =
      configuredWslDistro ??
      (folderWorkspace && isLocalHost
        ? (parseWslUncPath(target.worktree.path)?.distro ?? null)
        : null)
    return {
      executionHostId: target.executionHostId,
      wslDistro,
      workspaceId: target.worktree.id,
      workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
    }
  }

  /** Where a structured chat here would run, when that is a directory on this machine. */
  async resolveStructuredAgentSessionLocalWorkspacePath(worktreeSelector: string) {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro) {
      return null
    }
    return (await this.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'claude' | 'codex'
    callerKey?: string
    resumeFrom?: { providerSessionId: string }
  }): Promise<AgentSessionAttachParams> {
    if (input.agent === 'claude') {
      return this.resolveStructuredAgentSessionIntent(input, async ({ launchEnv, location }) =>
        resolveStructuredClaudeAccountHomePath({
          launchEnv,
          wslDistro: location.wslDistro,
          getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target)
        })
      )
    }
    return this.resolveStructuredAgentSessionIntent(input, async ({ launchEnv }) => {
      await applyStructuredCodexWorkspaceTrust({
        workspacePath: (await this.resolveRuntimeFileTarget(input.worktree)).worktree.path,
        launchEnv,
        settings: this.requireStore().getSettings()
      })
      return resolveStructuredCodexAccountHomePath({
        launchEnv,
        resolveLaunchHome: this.prepareCodexStructuredLaunchFn
      })
    })
  }

  /**
   * The account home a structured launch for this agent would pin right now,
   * for reads that have no session record to answer from (the model catalog).
   * Same resolver as the create intent above — never a second copy.
   */
  async resolveStructuredAgentAccountHome(
    agent: 'claude' | 'codex'
  ): Promise<{ variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; path: string }> {
    const launchEnv = resolveTuiAgentLaunchEnv(
      agent,
      this.requireStore().getSettings().agentDefaultEnv
    )
    if (agent === 'claude') {
      return {
        variable: 'CLAUDE_CONFIG_DIR',
        path: resolveStructuredClaudeAccountHomePath({
          launchEnv,
          wslDistro: null,
          getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target)
        })
      }
    }
    return {
      variable: 'CODEX_HOME',
      // Read-only resolver, never launch prep: a picker mount or discovery read
      // must not sync homes, start bridges, or clear an account selection.
      path: await resolveStructuredCodexAccountHomePath({
        launchEnv,
        resolveLaunchHome: this.resolveCodexStructuredLaunchHomeFn
      })
    }
  }

  protected async resolveStructuredAgentSessionIntent(
    input: {
      envelope: { sessionId: string; clientOperationId: string }
      worktree: string
      agent: 'claude' | 'codex'
      callerKey?: string
      resumeFrom?: { providerSessionId: string }
    },
    resolveAccountHomePath: (context: {
      launchEnv: NodeJS.ProcessEnv
      location: {
        executionHostId: string
        wslDistro: string | null
        workspaceId: string
        workspaceKind: 'folder' | 'git-worktree'
      }
    }) => string | Promise<string>
  ): Promise<AgentSessionAttachParams> {
    const support = await this.getStructuredAgentSessionCreateSupport(input.worktree, input.agent)
    if (!support.supported) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const settings = this.requireStore().getSettings()
    const launchEnv = resolveTuiAgentLaunchEnv(input.agent, settings.agentDefaultEnv)
    const options = resolveStructuredLaunchSeedOptions(
      settings.nativeChatSessionOptions,
      input.agent
    )
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    const host = getStructuredAgentSessionHost()
    const committedReplay = resolveCommittedStructuredAgentSessionAdoptionIntent({
      host,
      ...input,
      location,
      ...(options ? { options } : {})
    })
    if (committedReplay) {
      return committedReplay
    }
    const selectedAccountHomePath = await resolveAccountHomePath({ launchEnv, location })
    // Adopting pins the account home to wherever the conversation actually lives, which is not
    // necessarily the one a fresh create would pick: Codex resolves its rollout under
    // `accountHome.path`, and Claude reads its transcript under `<home>/projects`. Resuming under
    // the wrong home finds nothing and lands the user in a blank chat wearing the old chat's name.
    const adoption = input.resumeFrom
      ? await resolveStructuredAgentSessionAdoptionForCreate({
          host,
          settings,
          agent: input.agent,
          providerSessionId: input.resumeFrom.providerSessionId,
          selfSessionId: input.envelope.sessionId,
          selectedAccountHomePath
        })
      : null
    return {
      envelope: {
        sessionId: input.envelope.sessionId,
        clientOperationId: input.envelope.clientOperationId,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location,
      provider: input.agent,
      agent: input.agent,
      accountHome: {
        variable: input.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: adoption ? adoption.accountHomePath : selectedAccountHomePath
      },
      ...(options ? { options } : {}),
      ...(input.resumeFrom && adoption
        ? {
            // `adopt` is what makes the reservation seed the handle chain. Presence of
            // `providerHandle` alone must not: `agentSession.ensure` already passes one today
            // without adopting anything.
            adopt: {
              providerHandle:
                input.agent === 'claude'
                  ? {
                      kind: 'claude' as const,
                      sessionId: input.resumeFrom.providerSessionId,
                      leafUuid: null
                    }
                  : { kind: 'codex' as const, threadId: input.resumeFrom.providerSessionId },
              transcriptPath: adoption.transcriptPath
            }
          }
        : {}),
      runtimeKind: 'native'
    }
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??= this.structuredAgentSessionStartupChatWork
      .trackListing(() => this.restoreStructuredAgentSessionTabsOnce())
      .then(
        () => {
          // Only a host's answer is final: without one, the next caller restores again, so a journal
          // that opens later republishes the chats.
          if (this.structuredAgentSessionInventoryUnverifiable) {
            this.structuredAgentSessionTabRestorePromise = null
          }
        },
        (error) => {
          this.structuredAgentSessionTabRestorePromise = null
          throw error
        }
      )
    return this.structuredAgentSessionTabRestorePromise
  }

  /** Starts the history restore the tab restore owes, once. On the next macrotask, so a caller that
   *  starts it as it answers has sent that answer first. */
  startStructuredAgentSessionHistoryRestore(): void {
    this.structuredAgentSessionStartupChatWork.startOwedRestoreSoon()
  }

  /** The tab restore's preparation: the startup step, then the terminal records refresh, which
   *  lists the daemon's terminals against the records the host build brought in. */
  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    this.structuredAgentSessionStartupRestorePromise ??= this.structuredAgentSessionStartupChatWork
      .trackRestorationPrepare(async () => {
        await this.startStructuredAgentSessionStartup()
        if (this.hasPersistedStructuredAgentSessionStore()) {
          await this.refreshMobileSessionPtyRecords()
        }
      })
      .catch((error) => {
        this.structuredAgentSessionStartupRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionStartupRestorePromise
  }

  /**
   * Desktop launch. The step needs neither the terminal daemon nor the hook server (structured
   * chats never run in WSL, the lease check probes processes, and the seed publishes in process),
   * so only the shell PATH is awaited, as before: the host build sets up the agents' launch
   * environments from it. Off Windows it is already resolved.
   */
  startStructuredAgentSessionStartupAfter(shellPathReady: Promise<unknown>): void {
    void shellPathReady
      .then(() => this.startStructuredAgentSessionStartup())
      .catch(this.reportStructuredAgentSessionStartupFailure)
  }

  /** `prepare` once `after` resolves, its failure reported rather than thrown: desktop runs it once
   *  the first window's services are up or timed out, orcad at once. */
  prepareStructuredAgentSessionStartupRestorationAfter(after: Promise<unknown>): void {
    void after
      .then(() => this.prepareStructuredAgentSessionStartupRestoration())
      .catch(this.reportStructuredAgentSessionStartupFailure)
  }

  /** A failed host build or seed at launch: in the diagnostics trace, not only the console. */
  private reportStructuredAgentSessionStartupFailure = (error: unknown): void => {
    this.structuredAgentSessionStartupLogger.warn('the chat startup step failed', {
      scope: 'startup-step-failed',
      error
    })
  }

  /** The host's startup step, once: the host build, then the lease check, seed and settle. */
  startStructuredAgentSessionStartup(): Promise<void> {
    this.structuredAgentSessionStartupStepPromise ??=
      this.startStructuredAgentSessionStartupOnce().catch((error) => {
        this.structuredAgentSessionStartupStepPromise = null
        throw error
      })
    return this.structuredAgentSessionStartupStepPromise
  }

  protected async startStructuredAgentSessionStartupOnce(): Promise<void> {
    const background = await runStructuredAgentSessionStartup({
      gate: this.structuredAgentSessionStartupGate,
      hasChatsOnDisk: () => this.hasPersistedStructuredAgentSessionStore(),
      buildHost: () => this.ensureStructuredAgentSessionHost(),
      savedSession: () => this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null,
      isRuntimeChatWorkActive: this.structuredAgentSessionStartupChatWork.isActive
    })
    if (background) {
      this.structuredAgentSessionBackgroundRestoreIds = background
    }
  }

  protected hasPersistedStructuredAgentSessionStore(): boolean {
    return hasPersistedStructuredAgentSessionStoreOnDisk(getProfileUserDataPath())
  }
}
