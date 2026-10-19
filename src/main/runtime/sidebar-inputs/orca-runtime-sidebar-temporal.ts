import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import type { OrcaRuntimeWithAgentTransitions } from '../orca-runtime-agent-transitions'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { DEFAULT_HIDE_SLEEPING_WORKSPACES } from '../../../shared/constants'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  isLocalExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SidebarTemporalSnapshot } from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { SidebarRetentionOwner, type SidebarRetentionCandidates } from './sidebar-retention-owner'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'
import { SortStampsProducer } from './sort-stamps-producer'
import { writeUnreadFlag } from './sort-stamp-records'
import { WorkspaceViewers } from './workspace-viewers'
import { clientRaisesUnreadFlagItself } from '../../../shared/workspace-unread-raise-capability'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { TerminalUseProducer } from './terminal-use-producer'
import { createKeyedTrailingEdgeCoalescer } from '../keyed-trailing-edge-coalescer'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { resolveAgentWorkspaceExecutionHostId } from '../../agent-hooks/restored-status-dead-terminal-sweep'
import {
  isWslMoveProjectBlocked,
  wslMoveProjectRefForWorkspace
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

/**
 * Feeds main's sleeping retention, and owns the host's sort stamps: clients sort by those, so main
 * keeps no order of its own.
 */
export abstract class OrcaRuntimeWithSidebarTemporal extends OrcaRuntimeWithWorkspaceReviewFacts {
  private readonly sidebarTemporal = new SidebarRetentionOwner(this.sidebarClock, {
    // The durable file keeps the hide form; the window reads it the same way at hydration.
    showSleepingWorkspaces: () =>
      !(this.store?.getUI?.().hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
    listRows: () => this.listSidebarRows(),
    retentionCandidates: () => this.readSidebarRetentionCandidates()
  })
  readonly workspaceViewers = new WorkspaceViewers(Date.now)
  // A streaming agent can flip its title many times a second; each notice makes every client
  // re-list the repo, so a burst is announced once. The store is already written.
  private readonly sortStampNotices = createKeyedTrailingEdgeCoalescer(
    (worktreeId) => this.notifySortStampsChanged(worktreeId),
    { flushMs: 50, maxWaitMs: 250 }
  )
  readonly sortStamps = new SortStampsProducer({
    store: () => this.store,
    isWriteFenced: (worktreeId) =>
      isWslMoveProjectBlocked(this.store ?? undefined, wslMoveProjectRefForWorkspace(worktreeId)),
    subscribeToPtyExit: (ptyId, listener) => this.subscribeToPtyExit(ptyId, listener),
    onClientEvent: (listener, options) => this.onClientEvent(listener, options),
    isViewing: (worktreeId, paneKey) => this.workspaceViewers.isViewing(worktreeId, paneKey),
    onStampsWritten: (worktreeId) => {
      this.invalidateResolvedWorktreeCache()
      this.sortStampNotices.schedule(worktreeId)
    },
    now: Date.now
  })
  readonly terminalUse = new TerminalUseProducer({
    store: () => this.store,
    workspaceOfPty: (ptyId) => {
      // A paired server's terminal is that server's to record.
      const pty = isRemoteRuntimePtyId(ptyId) ? undefined : this.ptysById.get(ptyId)
      if (!pty?.worktreeId) {
        return null
      }
      const hostId = getConnectionExecutionHostId(pty.connectionId)
      return {
        worktreeId: pty.worktreeId,
        sshHostId: hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
      }
    },
    isWriteFenced: (worktreeId) =>
      isWslMoveProjectBlocked(this.store ?? undefined, wslMoveProjectRefForWorkspace(worktreeId))
  })

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceReviewFacts>) {
    super(...args)
    this.workspaceActivityFacts.revision.onChange(() => this.sidebarTemporal.noteActivityChange())
    this.store?.onUIChanged?.(() => this.sidebarTemporal.noteViewChange())
    this.terminalRunFacts.onInput((ptyId, now) => this.terminalUse.noteTerminalUse(ptyId, now))
    // Every catalog change, from IPC or the runtime, reaches clients through this one bus.
    this.clientEvents.on(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.sidebarTemporal.noteCatalogChange()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  }

  getSidebarTemporalSnapshot(): SidebarTemporalSnapshot {
    return this.sidebarTemporal.snapshot()
  }

  onSidebarTemporalChange(listener: () => void): () => void {
    return this.sidebarTemporal.revision.onChange(listener)
  }

  beginSidebarListSession(sessionId: string): void {
    this.sidebarTemporal.beginSession(sessionId)
  }

  /** After a restart, once hook rows and the provider's PTYs settle: drop tiers nothing backs. */
  async reconcileSortStampTiers(provider: {
    probePtyLiveness?: (ptyId: string) => Promise<boolean | null>
  }): Promise<void> {
    const store = this.store
    await this.sortStamps
      .reconcileStoredTiers({
        isLocalWorkspace: (worktreeId) =>
          !!store && isLocalExecutionHost(this.workspaceHostId(worktreeId)),
        terminalPtyIds: (worktreeId) => {
          const session = store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
          const ptyIds = new Set<string>()
          for (const tab of session?.tabsByWorktree?.[worktreeId] ?? []) {
            if (tab.ptyId) {
              ptyIds.add(tab.ptyId)
            }
            for (const ptyId of Object.values(
              session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
            )) {
              ptyIds.add(ptyId)
            }
          }
          for (const pty of this.ptysById.values()) {
            if (pty.worktreeId === worktreeId) {
              ptyIds.add(pty.ptyId)
            }
          }
          return [...ptyIds]
        },
        // A provider that cannot probe proves nothing absent.
        probePtyLiveness: async (ptyId) => (await provider.probePtyLiveness?.(ptyId)) ?? null
      })
      .catch((error: unknown) => console.warn('[sidebar] sort tier reconcile failed:', error))
  }

  /** A paired desktop connected; while one that raises the unread flag itself is here, this host doesn't. */
  noteRuntimeClient(connectionId: string, capabilities: readonly RuntimeCapability[]): void {
    if (!clientRaisesUnreadFlagItself(capabilities)) {
      return
    }
    this.workspaceViewers.noteSelfRaisingClient(connectionId)
    this.registerSubscriptionCleanup(
      `sidebar-self-raising-${connectionId}`,
      () => this.workspaceViewers.dropClient(connectionId),
      connectionId
    )
  }

  /** A phone holding the workspace's session open has it on screen: its flag is read and stays down. */
  readAndHoldPhoneSession(worktreeId: string): () => void {
    const hostId = this.workspaceHostId(worktreeId)
    const workspace = {
      worktreeId,
      sshHostId: hostId && parseExecutionHostId(hostId)?.kind === 'ssh' ? hostId : null
    }
    if (writeUnreadFlag(this.store, workspace, false)) {
      this.sortStampNotices.cancel(worktreeId)
      this.notifySortStampsChanged(worktreeId)
    }
    return this.workspaceViewers.openPhoneSession(worktreeId)
  }

  private workspaceHostId(worktreeId: string): ExecutionHostId | null {
    const store = this.store
    return store
      ? resolveAgentWorkspaceExecutionHostId(worktreeId, {
          getRepo: (repoId) => store.getRepo(repoId),
          getWorktreeMeta: (id) => store.getWorktreeMeta(id),
          getFolderWorkspace: (id) => store.getFolderWorkspace?.(id),
          getProjectGroups: () => store.getProjectGroups?.() ?? []
        })
      : null
  }

  // Metadata only: clients re-list the record, and the cached git scans stay.
  private notifySortStampsChanged(worktreeId: string): void {
    if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
      this.notifyFolderWorkspaceChanged()
      return
    }
    this.invalidateResolvedWorktreeCache()
    this.notifyWorktreesChanged(getRepoIdFromWorktreeId(worktreeId), { invalidateGitScans: false })
  }

  override attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    // The sidebar subscribes first, so the statuses present at attach reach it as seeds.
    const detachActivity = this.workspaceActivityFacts.attachAgentStatusStore(store)
    const detachStamps = this.sortStamps.attachAgentTransitions(this.agentTransitions)
    const detachTransitions = super.attachAgentStatusStore(store)
    return () => {
      detachTransitions()
      detachActivity()
      detachStamps()
      this.sidebarTemporal.dispose()
      this.sortStampNotices.dispose()
    }
  }

  // Retained ids are host-qualified; a row without a stamped host belongs to its repo's host.
  private async listSidebarRows(repoById = this.readSidebarRepoMap()): Promise<Worktree[]> {
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    return worktrees.map((worktree) => {
      const repo = repoById.get(worktree.repoId)
      return worktree.hostId || !repo
        ? worktree
        : { ...worktree, hostId: getRepoExecutionHostId(repo) }
    })
  }

  private readSidebarRepoMap(): Map<string, Repo> {
    return new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
  }

  private readSidebarRetentionCandidates(): SidebarRetentionCandidates {
    const { facts } = this.workspaceActivityFacts.snapshot()
    return {
      ids: Object.keys(facts),
      isActive: (worktreeId) => worktreeId in facts,
      isUnverifiableGap: (worktreeId) =>
        !this.terminalSleepByWorktreeId.has(worktreeId) &&
        (this.mobileSessionTabsByWorktree
          .get(worktreeId)
          ?.tabs.some((tab) => tab.type === 'terminal') ??
          [...this.tabs.values()].some((tab) => tab.worktreeId === worktreeId))
    }
  }
}

/** The top sidebar layer, so a switch-off build folds the instanceof away with the switch. */
export function sidebarFactsRuntime(
  runtime: OrcaRuntimeWithAgentTransitions
): OrcaRuntimeWithSidebarTemporal | null {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN && runtime instanceof OrcaRuntimeWithSidebarTemporal
    ? runtime
    : null
}
