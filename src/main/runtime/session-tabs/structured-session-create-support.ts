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

  /** Use this runtime's registered definition to pin account home; reads/create must not install the host just to inspect it. */
  protected requireRegisteredStructuredAgent(agent: StructuredAgentId) {
    const definition = structuredAgentRuntimeMetadata(agent)?.definition
    if (!definition) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    return definition
  }

  /** Share new-chat selection between create and createSupport so client pickers show what create will run. */
  structuredAgentSessionLaunchSeedOptions(
    agent: StructuredAgentId
  ): Record<string, string> | undefined {
    return structuredLaunchSeedOptions(this.requireStore().getSettings(), agent)
  }

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.store?.getRepo(target.worktree.repoId)
    const folderScope = parseWorkspaceKey(target.worktree.id)
    // Floating workspaces are plain managed directories; folder describes management, not whether they contain Git.
    const folderWorkspace =
      folderScope?.type === 'folder' || isFloatingWorkspaceId(target.worktree.id)
    // WSL routing is local-machine authority; use executionHostId so remote/runtime hosts cannot inherit it.
    const isLocalHost = target.executionHostId === LOCAL_EXECUTION_HOST_ID
    const configuredWslDistro =
      repo && isLocalHost
        ? (getLocalProjectWorktreeGitOptions(this.requireStore(), repo).wslDistro ?? null)
        : null
    // Folder workspaces lack repo Git options; WSL UNC paths are their durable signal to refuse native Windows Codex.
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
        // Refuse transfer from a live terminal or the chat's first send starts a second writer.
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

  /** Resolve catalog account home through the same host create-intent resolver when no session record exists. */
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
    // Adoption pins the transcript's actual account home; fresh-create defaults may open a blank conversation under the old name.
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
          // Only host answers finalize restoration; without one, retry so journals opened later can publish.
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
    // Load durable agent records before reconciling daemon inventory; refused hosts block only structured requests, not app startup.
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
