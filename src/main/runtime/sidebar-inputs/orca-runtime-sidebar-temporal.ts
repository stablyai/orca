import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import type { OrcaRuntimeWithMigrationCatalog } from '../orca-runtime-migration-catalog'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { DEFAULT_HIDE_SLEEPING_WORKSPACES } from '../../../shared/constants'
import {
  getRepoExecutionHostId,
  isLocalExecutionHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { detectAgentStatusFromTitle } from '../../../shared/agent-detection'
import type { SidebarTemporalSnapshot } from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { getMigrationUnsupportedPtySnapshot } from '../../agent-hooks/migration-unsupported-pty-state'
import {
  SidebarTemporalOwner,
  type SidebarRetentionCandidates,
  type SidebarSortSample
} from './sidebar-temporal-owner'
import { SmartSortAgentEntries } from './smart-sort-agent-entries'
import { buildRuntimeSmartSortSources } from './runtime-smart-sort-sources'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'
import { SortStampsProducer } from './sort-stamps-producer'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { resolveAgentWorkspaceExecutionHostId } from '../../agent-hooks/restored-status-dead-terminal-sweep'
import {
  isWslMoveProjectBlocked,
  wslMoveProjectRefForWorkspace
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

type Runtime = OrcaRuntimeWithWorkspaceReviewFacts

/**
 * Feeds main's temporal owner. Its sort inputs restart the settle window where the window's
 * sortEpoch bumps and main can see the cause: catalog changes, agent rows, and pane titles.
 */
export abstract class OrcaRuntimeWithSidebarTemporal extends OrcaRuntimeWithWorkspaceReviewFacts {
  private readonly smartSortAgentEntries = new SmartSortAgentEntries()
  private readonly sidebarTemporal = new SidebarTemporalOwner(this.sidebarClock, {
    sortBy: () => this.store?.getUI?.().sortBy ?? 'smart',
    // The durable file keeps the hide form; the window reads it the same way at hydration.
    showSleepingWorkspaces: () =>
      !(this.store?.getUI?.().hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
    readSortSample: () => this.readSidebarSortSample(),
    retentionCandidates: () => this.readSidebarRetentionCandidates()
  })
  readonly sortStamps = new SortStampsProducer({
    store: () => this.store,
    isWriteFenced: (worktreeId) =>
      isWslMoveProjectBlocked(this.store ?? undefined, wslMoveProjectRefForWorkspace(worktreeId)),
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    subscribeToPtyExit: (ptyId, listener) => this.subscribeToPtyExit(ptyId, listener),
    onClientEvent: (listener, options) => this.onClientEvent(listener, options),
    onStampsWritten: (worktreeId) => this.notifySortStampsChanged(worktreeId),
    now: Date.now
  })

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceReviewFacts>) {
    super(...args)
    this.workspaceActivityFacts.revision.onChange(() => this.sidebarTemporal.noteActivityChange())
    this.store?.onUIChanged?.(() => this.sidebarTemporal.noteViewChange())
    // Switch point: the window's metadata writes (a rename, a manual order) send no catalog event.
    this.store?.onStateWritten?.((domains) => {
      if (
        ORCA_SIDEBAR_INPUTS_IS_MAIN &&
        domains &&
        WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain))
      ) {
        this.invalidateResolvedWorktreeCache()
        this.sidebarTemporal.noteRowsWritten()
      }
    })
    // Every catalog change, from IPC or the runtime, reaches clients through this one bus.
    this.clientEvents.on(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.noteSidebarCatalogChange(event.type)
        }
      },
      { consumesTerminalSideEffects: false }
    )
  }

  // Listed after the change lands, as the window re-lists; only rows, the sort's sources wait.
  private noteSidebarCatalogChange(type: 'worktreesChanged' | 'reposChanged'): void {
    if (!this.sidebarTemporal.running) {
      return
    }
    void this.listSidebarRows().then(
      (worktrees) => this.sidebarTemporal.noteCatalogListing(worktrees, type === 'reposChanged'),
      (error: unknown) => console.warn('[sidebar-temporal] could not list rows', error)
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
          !!store &&
          isLocalExecutionHost(
            resolveAgentWorkspaceExecutionHostId(worktreeId, {
              getRepo: (repoId) => store.getRepo(repoId),
              getWorktreeMeta: (id) => store.getWorktreeMeta(id),
              getFolderWorkspace: (id) => store.getFolderWorkspace?.(id),
              getProjectGroups: () => store.getProjectGroups?.() ?? []
            })
          ),
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

  // Metadata only: clients re-list the record, and the cached git scans stay.
  private notifySortStampsChanged(worktreeId: string): void {
    if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
      this.notifyFolderWorkspaceChanged()
      return
    }
    this.invalidateResolvedWorktreeCache()
    this.notifyWorktreesChanged(getRepoIdFromWorktreeId(worktreeId), { invalidateGitScans: false })
  }

  /** Attaches every sidebar producer that reads the hook server's store. */
  attachSidebarAgentStatusStore(store: AgentStatusStoreView): () => void {
    const detachActivity = this.workspaceActivityFacts.attachAgentStatusStore(store)
    const detachStamps = this.sortStamps.attachAgentStatusStore(store)
    const detachEntries = this.smartSortAgentEntries.attach(store, () =>
      this.sidebarTemporal.noteSortInputChange()
    )
    return () => {
      detachActivity()
      detachStamps()
      detachEntries()
      this.sidebarTemporal.dispose()
    }
  }

  override syncWindowGraph(...args: Parameters<Runtime['syncWindowGraph']>) {
    if (!this.sidebarTemporal.running) {
      return super.syncWindowGraph(...args)
    }
    const before = this.readSidebarGraphSortCauses()
    const result = super.syncWindowGraph(...args)
    const after = this.readSidebarGraphSortCauses()
    // A title's reading counts both ways; a tab only re-sorts when it gains its first terminal.
    const resorts = (key: string): boolean =>
      key.startsWith('title:')
        ? (before.get(key) ?? '') !== (after.get(key) ?? '')
        : after.has(key) && !before.has(key)
    if ([...new Set([...before.keys(), ...after.keys()])].some(resorts)) {
      this.sidebarTemporal.noteSortInputChange()
    }
    return result
  }

  /**
   * What a graph sync can change that the window re-sorts on: a pane title's agent reading on a
   * workspace not in front, and the first live terminal of a tab in the workspace in front.
   */
  private readSidebarGraphSortCauses(): Map<string, string> {
    const active = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.activeWorktreeId
    const causes = new Map<string, string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === active) {
        if (leaf.ptyId) {
          causes.set(`pty:${leaf.tabId}`, 'live')
        }
      } else if (leaf.paneTitle) {
        causes.set(
          `title:${leaf.tabId}:${leaf.paneRuntimeId}`,
          detectAgentStatusFromTitle(leaf.paneTitle) ?? ''
        )
      }
    }
    return causes
  }

  // Ranks are host-qualified; a row without a stamped host belongs to its repo's host.
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

  private async readSidebarSortSample(): Promise<SidebarSortSample> {
    const repoMap = this.readSidebarRepoMap()
    return {
      worktrees: await this.listSidebarRows(repoMap),
      repoMap,
      sources: buildRuntimeSmartSortSources({
        tabs: this.tabs.values(),
        leaves: this.leaves.values(),
        sessionTabs: this.mobileSessionTabsByWorktree,
        isUnverifiablePty: (ptyId) => this.getPtyLivenessVerdict(ptyId)?.status === 'unverifiable',
        agentStatusByPaneKey: this.smartSortAgentEntries.byPaneKey(),
        migrationUnsupported: getMigrationUnsupportedPtySnapshot()
      })
    }
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
  runtime: OrcaRuntimeWithMigrationCatalog
): OrcaRuntimeWithSidebarTemporal | null {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN && runtime instanceof OrcaRuntimeWithSidebarTemporal
    ? runtime
    : null
}
