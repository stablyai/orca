import {
  captureStructuredAgentCliSource,
  structuredAgentCliSourcePathFromEvidence
} from '../../native-chat/structured-agent-cli-source'
import type { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce as RestoreStructuredAgentSessionTabsOnceMethods } from './structured-session-tab-restoration'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  resolveCommittedStructuredAgentSessionAdoptionIntent,
  requireUnownedStructuredAgentSessionAdoption,
  resolveStructuredAgentSessionAdoptionForCreate,
  structuredAgentSessionAdoptAttach,
  type StructuredAgentSessionCreateIntentInput
} from '../structured-agent-session-create-adoption'
import { isNativeLocalLocation, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import type { AgentSessionAttachParams } from '../../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  resolveHostStructuredAgentCreateSupport,
  resolveHostStructuredAgentLaunchEnvironment
} from '../structured-agent-launch-support'
import { structuredAgentRuntimeMetadata } from '../structured-agent-runtime-metadata'
import { structuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import { hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk } from '../structured-agent-session-runtime'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../structured-agent-session-host-refusal'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  isFloatingWorkspaceId,
  isFloatingWorkspaceSelector
} from '../../../shared/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'

export abstract class OrcaRuntimeWithGetStructuredAgentSessionCreateSupport extends OrcaRuntimeWithStructuredSessionAccountHome {
  protected abstract restoreStructuredAgentSessionTabsOnce(
    ...args: Parameters<
      RestoreStructuredAgentSessionTabsOnceMethods['restoreStructuredAgentSessionTabsOnce']
    >
  ): ReturnType<
    RestoreStructuredAgentSessionTabsOnceMethods['restoreStructuredAgentSessionTabsOnce']
  >

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: StructuredAgentId
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    return resolveHostStructuredAgentCreateSupport({
      agent,
      worktreeSelector,
      location: await this.resolveStructuredAgentSessionLocation(worktreeSelector),
      runtime: this
    })
  }

  /** The definition this runtime registers for `agent`: what its account home pins. Read from the
   *  registration list, so neither create nor a catalog read installs the host to learn it. */
  protected requireRegisteredStructuredAgent(agent: StructuredAgentId) {
    const definition = structuredAgentRuntimeMetadata(agent)?.definition
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
    return structuredLaunchSeedOptions(this.requireStore().getSettings(), agent)
  }

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.store?.getRepo(target.worktree.repoId)
    const folderScope = parseWorkspaceKey(target.worktree.id)
    // The floating workspace is a plain directory with no repo git options, which is exactly what
    // `folder` denotes here — it describes how Orca manages the place, not whether git is in it.
    const folderWorkspace =
      folderScope?.type === 'folder' || isFloatingWorkspaceId(target.worktree.id)
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
    if (!isNativeLocalLocation(location)) {
      return null
    }
    return (await this.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
  }

  async resolveStructuredAgentSessionCreateIntent(
    input: StructuredAgentSessionCreateIntentInput
  ): Promise<AgentSessionAttachParams & { hostLaunchDirectory?: string }> {
    if (input.resumeFrom) {
      const { providerSessionId, cliSource } = input.resumeFrom
      try {
        requireUnownedStructuredAgentSessionAdoption({
          host: getStructuredAgentSessionHost(),
          agent: input.agent,
          providerSessionId,
          selfSessionId: input.envelope.sessionId
        })
      } catch (ownerConflict) {
        // A switch out of a live terminal refuses as such: the owning chat's first send would
        // otherwise start a second writer.
        await this.assertStructuredAdoptionTerminalWritersExited(
          input.agent,
          providerSessionId,
          cliSource
        )
        throw ownerConflict
      }
    }
    const structuredAgentCliSourceEvidence =
      input.structuredAgentCliSourceEvidence ??
      (input.resumeFrom?.cliSource
        ? captureStructuredAgentCliSource(() => this.getAgentProviderSessionRows())
        : undefined)
    const hostLaunchDirectory = isFloatingWorkspaceSelector(input.worktree)
      ? (await this.resolveRuntimeFileTarget(input.worktree)).worktree.path
      : undefined
    const resolveAccountHome = this.structuredAgentAccountHomeResolver(
      input.agent,
      input.worktree,
      'launch',
      hostLaunchDirectory
    )
    if (!resolveAccountHome) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const resolved = await this.resolveStructuredAgentSessionIntent(
      { ...input, structuredAgentCliSourceEvidence },
      resolveAccountHome
    )
    return hostLaunchDirectory ? { ...resolved, hostLaunchDirectory } : resolved
  }

  /**
   * The account home a structured launch for this agent would pin right now,
   * for reads that have no session record to answer from (the model catalog).
   * Same resolver as the create intent above — never a second copy.
   */
  async resolveStructuredAgentAccountHome(
    agent: StructuredAgentId
  ): Promise<AgentSessionAccountHome> {
    const resolveAccountHome = this.structuredAgentAccountHomeResolver(agent, '', 'read')
    if (!resolveAccountHome) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const launchEnv = this.structuredAgentLaunchEnv(agent, this.requireStore().getSettings())
    return resolveAccountHome({ launchEnv, location: null })
  }

  protected async resolveStructuredAgentSessionIntent(
    input: StructuredAgentSessionCreateIntentInput,
    resolveAccountHome: (context: {
      launchEnv: NodeJS.ProcessEnv
      location: {
        executionHostId: string
        wslDistro: string | null
        workspaceId: string
        workspaceKind: 'folder' | 'git-worktree'
      }
    }) => AgentSessionAccountHome | Promise<AgentSessionAccountHome>
  ): Promise<AgentSessionAttachParams> {
    const support = await this.getStructuredAgentSessionCreateSupport(input.worktree, input.agent)
    // Adopting a conversation reads the agent's own transcript, so only an agent registered with an
    // importer adopts.
    const transcriptImport = structuredAgentRuntimeMetadata(input.agent)?.transcriptImport
    if (!support.supported || (input.resumeFrom && !transcriptImport)) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const settings = this.requireStore().getSettings()
    const launchEnv = this.structuredAgentLaunchEnv(input.agent, settings)
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
    const resumeFrom = input.resumeFrom
    if (resumeFrom) {
      await this.assertStructuredAdoptionTerminalWritersExited(
        input.agent,
        resumeFrom.providerSessionId,
        resumeFrom.cliSource
      )
    }
    const workspaceCwd = resumeFrom
      ? (await this.resolveRuntimeFileTarget(input.worktree)).worktree.path
      : ''
    const selectedAccountHome = await resolveAccountHome({ launchEnv, location })
    // Adopting pins the account home to wherever the conversation actually lives, which is not
    // necessarily the one a fresh create would pick: Codex resolves its rollout under
    // `accountHome.path`, and Claude reads its transcript under `<home>/projects`. Resuming under
    // the wrong home finds nothing and lands the user in a blank chat wearing the old chat's name.
    const adoption =
      resumeFrom && transcriptImport
        ? await resolveStructuredAgentSessionAdoptionForCreate({
            settings,
            agent: input.agent,
            transcriptImport,
            providerSessionId: resumeFrom.providerSessionId,
            resolveTranscriptPath: () =>
              structuredAgentCliSourcePathFromEvidence({
                agent: input.agent,
                resumeFrom,
                workspaceId: location.workspaceId,
                evidence: input.structuredAgentCliSourceEvidence
              }),
            prepareCodexResume: this.prepareAiVaultSessionResumeFn ?? undefined,
            selectedAccountHome,
            launchEnv: await resolveHostStructuredAgentLaunchEnvironment(input.agent, settings),
            workspaceCwd: workspaceCwd
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
      accountHome: adoption ? adoption.accountHome : selectedAccountHome,
      ...(options ? { options } : {}),
      ...(input.resumeFrom && adoption
        ? {
            adopt: structuredAgentSessionAdoptAttach({
              definition,
              handleNamesTranscript: transcriptImport!.handleNamesTranscript,
              transcriptPath: adoption.transcriptPath,
              providerSessionId: input.resumeFrom.providerSessionId,
              workspaceCwd
            })
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
