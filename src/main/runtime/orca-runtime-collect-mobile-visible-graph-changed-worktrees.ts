// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSyncWindowGraph } from './orca-runtime-sync-window-graph'
import type { RuntimeMobileSessionTabsResult, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { parseExecutionHostId } from '../../shared/execution-host'

export class OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees extends OrcaRuntimeWithSyncWindowGraph {
  // Why: toMobileSessionTabsResult resolves handles/titles from this.tabs and
  // this.leaves, so any tab/leaf delta a graph sync installs can flip the
  // client payload (pending-handle → ready, tab title) with zero change to the
  // stored snapshot. Compare exactly the projection-relevant fields and report
  // the affected worktrees; false positives only cost a coalesced no-op emit.
  protected collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.tabs) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.tabs.has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.leaves) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.leaves.has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.refreshMobileSessionPtyRecords(explicitWorktreeId)
      this.restoreLivePairedRendererSessionOwnedMobileTerminals(explicitWorktreeId)
      return this.getMobileSessionTabsForWorktree(explicitWorktreeId, clientNavigationId)
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.refreshMobileSessionPtyRecords()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    return this.getMobileSessionTabsForWorktree(worktree.id, clientNavigationId)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return (await this.listAllMobileSessionTabsWithChangeSequence(clientNavigationId)).snapshots
  }

  async listAllMobileSessionTabsWithChangeSequence(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
    return { snapshots: inventory.snapshots, changeSequence: inventory.changeSequence }
  }

  protected async collectAllMobileSessionTabs(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    ptyInventory: PtyControllerInventory | null
    changeSequence: number
  }> {
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    const ptyInventory = await this.refreshMobileSessionPtyInventory()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null)
    const snapshots = [...this.mobileSessionTabsByWorktree.values()].map((snapshot) =>
      this.projectMobileSessionTabsForClient(
        this.toMobileSessionTabsResult(snapshot),
        clientNavigationId
      )
    )
    return { snapshots, ptyInventory, changeSequence: this.mobileSessionTabsChangeSequence }
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    const { snapshots, authoritative } =
      await this.listAllMobileSessionTabsInventoryWithChangeSequence(clientNavigationId, signal)
    return { snapshots, ...(authoritative ? { authoritative } : {}) }
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    this.assertSessionTabsInventoryRequestActive(signal)
    const primedPublicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
    const primed = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.assertSessionTabsInventoryRequestActive(signal)
    if (
      primedPublicationEpoch !== null &&
      this.getAuthoritativeSessionTabsInventoryEpoch() === primedPublicationEpoch
    ) {
      return await this.settleSessionTabsInventory(primed, clientNavigationId, signal)
    }
    while (true) {
      const publicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
      if (publicationEpoch === null) {
        await this.waitForSessionTabsInventoryPublication(signal)
        continue
      }
      const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
      this.assertSessionTabsInventoryRequestActive(signal)
      if (this.getAuthoritativeSessionTabsInventoryEpoch() === publicationEpoch) {
        return await this.settleSessionTabsInventory(inventory, clientNavigationId, signal)
      }
    }
  }

  protected async settleSessionTabsInventory(
    inventory: {
      snapshots: RuntimeMobileSessionTabsResult[]
      ptyInventory: PtyControllerInventory | null
      changeSequence: number
    },
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    if (this.isCompleteSessionTabsPtyCensus(inventory.ptyInventory)) {
      return {
        snapshots: inventory.snapshots,
        authoritative: true,
        changeSequence: inventory.changeSequence
      }
    }
    const retried = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.assertSessionTabsInventoryRequestActive(signal)
    return { snapshots: retried.snapshots, changeSequence: retried.changeSequence }
  }

  supportsAuthoritativeSessionTabsInventory(): boolean {
    return process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1'
  }

  protected assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }

  protected isCompleteSessionTabsPtyCensus(inventory: PtyControllerInventory | null): boolean {
    if (!inventory) {
      return false
    }
    const knownHostIds = this.listKnownExecutionHostIds(inventory.queriedHostIds)
    return ![...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !inventory.queriedHostIds.has(hostId)
    })
  }
}
