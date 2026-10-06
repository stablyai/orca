// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { OrcaRuntimeWithGetWorktreePs } from './orca-runtime-get-worktree-ps'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { resolveStructuredAgentSessionCreateSupport } from '../native-chat/structured-agent-session-create-support'
import {
  resolveCommittedStructuredAgentSessionAdoptionIntent,
  resolveStructuredAgentSessionAdoptionForCreate
} from './structured-agent-session-create-adoption'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'
import { resolveStructuredLaunchSeedOptions } from '../../shared/native-chat-session-option-defaults'
import { hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk } from './structured-agent-session-runtime'
import { ensureStructuredAgentSessionHostUnlessRefused } from './structured-agent-session-host-refusal'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  agentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import {
  isAgentSessionHandleProvider,
  type StructuredAgentId
} from '../../shared/agent-session-provider-handle'
import { agentSessionWireProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

export class OrcaRuntimeWithGetStructuredAgentSessionCreateSupport extends OrcaRuntimeWithGetWorktreePs {
  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: StructuredAgentId
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    return resolveStructuredAgentSessionCreateSupport({
      agent,
      location,
      adapterSupportsCreate: await this.structuredAgentSupportsLocation(agent, location),
      getSettings: () => this.requireStore().getSettings()
    })
  }

  /** The agent's own location rule, from its registration: answered without installing the host,
   *  and false for an agent this runtime does not register. */
  protected async structuredAgentSupportsLocation(agent: StructuredAgentId, location) {
    return structuredAgentRuntimeRegistration(agent)?.supportsLocation(location) ?? false
  }

  /** Where a launch of `agent` finds its account, resolved on this host by the agent's own
   *  registration; null for an agent this runtime does not register, whose create is refused. */
  protected structuredAgentAccountHomePathResolver(
    agent: StructuredAgentId,
    worktree: string,
    purpose: 'launch' | 'read'
  ) {
    const registration = structuredAgentRuntimeRegistration(agent)
    if (!registration) {
      return null
    }
    const services = {
      getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target),
      prepareCodexLaunchHome: this.prepareCodexStructuredLaunchFn,
      readCodexLaunchHome: this.resolveCodexStructuredLaunchHomeFn,
      workspaceTrustSettings: () => this.requireStore().getSettings()
    }
    return async ({ launchEnv, location }) =>
      registration.resolveAccountHomePath(
        {
          launchEnv,
          location: location ?? null,
          purpose,
          workspacePath:
            purpose === 'launch'
              ? async () => (await this.resolveRuntimeFileTarget(worktree)).worktree.path
              : null
        },
        services
      )
  }

  /** The definition this runtime registers for `agent`: what its account home pins. Read from the
   *  registration list, so neither create nor a catalog read installs the host to learn it. */
  protected requireRegisteredStructuredAgent(agent: StructuredAgentId) {
    const definition = structuredAgentRuntimeRegistration(agent)?.definition
    if (!definition) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    return definition
  }

  /** The saved selection a new chat here starts with. createSupport reports it too, so a client's
   *  picker shows what create will run; one resolver keeps the two from drifting. */
  structuredAgentSessionLaunchSeedOptions(
    agent: StructuredAgentId
  ): Record<string, string> | undefined {
    return resolveStructuredLaunchSeedOptions(
      this.requireStore().getSettings().nativeChatSessionOptions,
      agent
    )
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
    agent: StructuredAgentId
    callerKey?: string
    resumeFrom?: { providerSessionId: string }
  }): Promise<AgentSessionAttachParams> {
    const resolveAccountHomePath = this.structuredAgentAccountHomePathResolver(
      input.agent,
      input.worktree,
      'launch'
    )
    if (!resolveAccountHomePath) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    return this.resolveStructuredAgentSessionIntent(input, resolveAccountHomePath)
  }

  /**
   * The account home a structured launch for this agent would pin right now,
   * for reads that have no session record to answer from (the model catalog).
   * Same resolver as the create intent above — never a second copy.
   */
  async resolveStructuredAgentAccountHome(
    agent: StructuredAgentId
  ): Promise<AgentSessionAccountHome> {
    const resolvePath = this.structuredAgentAccountHomePathResolver(agent, '', 'read')
    if (!resolvePath) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const definition = this.requireRegisteredStructuredAgent(agent)
    const launchEnv = resolveTuiAgentLaunchEnv(
      agent,
      this.requireStore().getSettings().agentDefaultEnv
    )
    return agentSessionAccountHome(definition, await resolvePath({ launchEnv, location: null }))
  }

  protected async resolveStructuredAgentSessionIntent(
    input: {
      envelope: { sessionId: string; clientOperationId: string }
      worktree: string
      agent: StructuredAgentId
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
    // Adopting a conversation reads the agent's own transcript, which only Claude and Codex have
    // importers for.
    if (!support.supported || (input.resumeFrom && !isAgentSessionHandleProvider(input.agent))) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const settings = this.requireStore().getSettings()
    const launchEnv = resolveTuiAgentLaunchEnv(input.agent, settings.agentDefaultEnv)
    const options = this.structuredAgentSessionLaunchSeedOptions(input.agent)
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    const definition = this.requireRegisteredStructuredAgent(input.agent)
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
      accountHome: agentSessionAccountHome(
        definition,
        adoption ? adoption.accountHomePath : selectedAccountHomePath
      ),
      ...(options ? { options } : {}),
      ...(input.resumeFrom && adoption
        ? {
            // `adopt` is what makes the reservation seed the handle chain. Presence of
            // `providerHandle` alone must not: `agentSession.ensure` already passes one today
            // without adopting anything.
            adopt: {
              providerHandle: agentSessionWireProviderHandle({
                transport: definition.handleTransport,
                agent: definition.agent,
                nativeId: input.resumeFrom.providerSessionId
              }),
              transcriptPath: adoption.transcriptPath
            }
          }
        : {}),
      runtimeKind: 'native'
    }
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??=
      this.restoreStructuredAgentSessionTabsOnce().then(
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

  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    this.structuredAgentSessionStartupRestorePromise ??=
      this.prepareStructuredAgentSessionStartupRestorationOnce().catch((error) => {
        this.structuredAgentSessionStartupRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionStartupRestorePromise
  }

  protected async prepareStructuredAgentSessionStartupRestorationOnce(): Promise<void> {
    if (!this.hasPersistedStructuredAgentSessionStore()) {
      return
    }
    // Durable agent records must exist before daemon inventory can be reconciled against them.
    // A refused host is no host: startup goes on, and only structured requests are refused.
    await ensureStructuredAgentSessionHostUnlessRefused(() =>
      this.ensureStructuredAgentSessionHost()
    )
    await this.refreshMobileSessionPtyRecords()
    await getStructuredAgentSessionHost()?.reconcileRestartLeases()
  }

  protected hasPersistedStructuredAgentSessionStore(): boolean {
    return hasPersistedStructuredAgentSessionStoreOnDisk(getProfileUserDataPath())
  }
}
