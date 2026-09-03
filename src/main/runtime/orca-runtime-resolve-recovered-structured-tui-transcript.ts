// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopStructuredSessionProcess } from './orca-runtime-stop-structured-session-process'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { agentSessionOwnerBindingsEqual } from '../../shared/claimed-agent-pty-owner-snapshot'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk } from './structured-agent-session-runtime'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export class OrcaRuntimeWithResolveRecoveredStructuredTuiTranscript extends OrcaRuntimeWithStopStructuredSessionProcess {
  protected async resolveRecoveredStructuredTuiTranscript(input: {
    handle: string
    paneKey: string
    threadId: string
    codexHome: string
    durableOwner: { binding: AgentSessionOwnerBinding; incarnationId: string }
  }): Promise<{ transcriptPath: string; leafUuid?: never }> {
    const assertDurableOwner = (): void => {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (
        !pty?.connected ||
        pty.paneKey !== input.paneKey ||
        pty.incarnationId !== input.durableOwner.incarnationId ||
        !pty.agentSessionOwners.some((owner) =>
          agentSessionOwnerBindingsEqual(owner, input.durableOwner.binding)
        )
      ) {
        throw new Error('The resumed terminal lost its durable owner identity.')
      }
    }
    assertDurableOwner()
    const transcriptPath = await resolvePinnedCodexRolloutProof(input.codexHome, input.threadId)
    assertDurableOwner()
    if (!transcriptPath) {
      throw new Error('The agent terminal did not prove the expected Codex rollout.')
    }
    return { transcriptPath }
  }

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    await this.ensureStructuredAgentSessionHost()
    if (getStructuredAgentSessionHost()?.supportsCreate(location, agent)) {
      return { supported: true }
    }
    return {
      supported: false,
      reason:
        location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : location.wslDistro
            ? 'wsl'
            : 'agent'
    }
  }

  protected hasProviderSessionObservationSource(): boolean {
    return (
      this.getAgentProviderSessionRowsForPaneFn !== null ||
      this.getAgentProviderSessionSnapshotFn !== null
    )
  }

  protected findAdoptedProviderSession(
    paneKey: string,
    provider: 'claude' | 'codex',
    providerSessionId: string
  ): AgentStatusIpcPayload | undefined {
    const rows =
      this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ??
      (this.getAgentProviderSessionSnapshotFn?.() ?? []).filter((row) => row.paneKey === paneKey)
    return rows
      .filter((row) => row.agentType === provider && row.providerSession?.id === providerSessionId)
      .reduce<AgentStatusIpcPayload | undefined>(
        (latest, row) => (!latest || row.receivedAt > latest.receivedAt ? row : latest),
        undefined
      )
  }

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.store?.getRepo(target.worktree.repoId)
    // WSL routing describes *this* machine; no remote or runtime host may inherit it.
    const wslDistro =
      repo && target.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? (getLocalProjectWorktreeGitOptions(this.requireStore(), repo).wslDistro ?? null)
        : null
    const folderWorkspace = this.store
      ?.getFolderWorkspaces?.()
      .some((workspace) => workspace.id === target.worktree.id)
    return {
      executionHostId: target.executionHostId,
      wslDistro,
      workspaceId: target.worktree.id,
      workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
    }
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'codex'
  }): Promise<AgentSessionAttachParams> {
    return this.resolveStructuredAgentSessionIntent(input, async ({ workspacePath, launchEnv }) => {
      // A create has no process yet, so the current selection is what it must follow.
      const preparedHome = await this.prepareCodexStructuredLaunchFn?.({ workspacePath, launchEnv })
      const configuredHome = launchEnv.CODEX_HOME
      return (
        preparedHome?.trim() ||
        (this.prepareCodexStructuredLaunchFn ? getSystemCodexHomePath() : configuredHome?.trim()) ||
        getSystemCodexHomePath()
      )
    })
  }

  protected async resolveStructuredAgentSessionIntent(
    input: {
      envelope: { sessionId: string; clientOperationId: string }
      worktree: string
      agent: 'codex'
    },
    resolveAccountHomePath: (context: {
      workspacePath: string
      launchEnv: NodeJS.ProcessEnv
    }) => string | Promise<string>
  ): Promise<AgentSessionAttachParams> {
    const support = await this.getStructuredAgentSessionCreateSupport(input.worktree, input.agent)
    if (!support.supported) {
      throw new Error('structured_agent_session_unsupported')
    }
    const settings = this.requireStore().getSettings()
    const launchEnv = resolveTuiAgentLaunchEnv(input.agent, settings.agentDefaultEnv)
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    const workspacePath = (await this.resolveRuntimeFileTarget(input.worktree)).worktree.path
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
        variable: 'CODEX_HOME',
        path: await resolveAccountHomePath({ workspacePath, launchEnv })
      },
      runtimeKind: 'native'
    }
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??=
      this.restoreStructuredAgentSessionTabsOnce().catch((error) => {
        this.structuredAgentSessionTabRestorePromise = null
        throw error
      })
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
    await this.ensureStructuredAgentSessionHost()
    await this.refreshMobileSessionPtyRecords()
    await getStructuredAgentSessionHost()?.reconcileRestartLeases()
  }

  protected hasPersistedStructuredAgentSessionStore(): boolean {
    return hasPersistedStructuredAgentSessionStoreOnDisk(getProfileUserDataPath())
  }
}
