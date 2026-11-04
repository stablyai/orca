import { visibleGraphChangedWorktrees } from '../session-graph/visible-graph-changed-worktrees'
import type { RuntimeSessionTabsInventoryPublication as SessionTabsInventoryPublicationMethods } from './session-tabs-inventory-publication'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree as ResolveBrowserNetworkExecutionHostForWorktreeMethods } from '../terminal/launch/terminal-workspace-scope'
import type { OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession as HydrateHeadlessMobileSessionTabsFromWorkspaceSessionMethods } from './mobile-session-hydration'
import type { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs as BuildHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/build-headless-mobile-session-browser-tabs'
import type { OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals as RestoreLivePairedRendererSessionOwnedMobileTerminalsMethods } from './renderer-session-terminal-rescue'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as PruneMobileSessionTabGroupLayoutMethods } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import { OrcaRuntimeWithMainSessionSurfaces } from '../session-graph/session-main-surfaces'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeSyncedTab
} from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'
import type { PtyControllerInventory } from '../runtime-pty-controller-contract'

export abstract class OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees extends OrcaRuntimeWithMainSessionSurfaces {
  protected abstract getAuthoritativeSessionTabsInventoryEpoch(
    ...args: Parameters<
      SessionTabsInventoryPublicationMethods['getAuthoritativeSessionTabsInventoryEpoch']
    >
  ): ReturnType<SessionTabsInventoryPublicationMethods['getAuthoritativeSessionTabsInventoryEpoch']>

  protected abstract getMobileSessionTabsForWorktree(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsForWorktree']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsForWorktree']>

  protected abstract getMobileSessionTabsWithoutSenders(
    ...args: Parameters<
      ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsWithoutSenders']
    >
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsWithoutSenders']>

  protected abstract getMobileSessionTabsForWorktreeWithChangeSequence(
    ...args: Parameters<
      ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsForWorktreeWithChangeSequence']
    >
  ): ReturnType<
    ScheduleMobileSessionTabsChangedMethods['getMobileSessionTabsForWorktreeWithChangeSequence']
  >

  protected abstract getValidatedExplicitWorktreeIdSelector(
    ...args: Parameters<
      ResolveBrowserNetworkExecutionHostForWorktreeMethods['getValidatedExplicitWorktreeIdSelector']
    >
  ): ReturnType<
    ResolveBrowserNetworkExecutionHostForWorktreeMethods['getValidatedExplicitWorktreeIdSelector']
  >

  abstract getExplicitSessionWorktreeIdSelector(
    ...args: Parameters<
      ResolveBrowserNetworkExecutionHostForWorktreeMethods['getExplicitSessionWorktreeIdSelector']
    >
  ): ReturnType<
    ResolveBrowserNetworkExecutionHostForWorktreeMethods['getExplicitSessionWorktreeIdSelector']
  >

  protected abstract hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    ...args: Parameters<
      HydrateHeadlessMobileSessionTabsFromWorkspaceSessionMethods['hydrateHeadlessMobileSessionTabsFromWorkspaceSession']
    >
  ): ReturnType<
    HydrateHeadlessMobileSessionTabsFromWorkspaceSessionMethods['hydrateHeadlessMobileSessionTabsFromWorkspaceSession']
  >

  protected abstract projectMobileSessionTabsForClient(
    ...args: Parameters<
      BuildHeadlessMobileSessionBrowserTabsMethods['projectMobileSessionTabsForClient']
    >
  ): ReturnType<BuildHeadlessMobileSessionBrowserTabsMethods['projectMobileSessionTabsForClient']>

  protected abstract refreshMobileSessionPtyInventory(
    ...args: Parameters<
      BuildHeadlessMobileSessionBrowserTabsMethods['refreshMobileSessionPtyInventory']
    >
  ): ReturnType<BuildHeadlessMobileSessionBrowserTabsMethods['refreshMobileSessionPtyInventory']>

  protected abstract refreshMobileSessionPtyRecords(
    ...args: Parameters<
      BuildHeadlessMobileSessionBrowserTabsMethods['refreshMobileSessionPtyRecords']
    >
  ): ReturnType<BuildHeadlessMobileSessionBrowserTabsMethods['refreshMobileSessionPtyRecords']>

  protected abstract restoreLivePairedRendererSessionOwnedMobileTerminals(
    ...args: Parameters<
      RestoreLivePairedRendererSessionOwnedMobileTerminalsMethods['restoreLivePairedRendererSessionOwnedMobileTerminals']
    >
  ): ReturnType<
    RestoreLivePairedRendererSessionOwnedMobileTerminalsMethods['restoreLivePairedRendererSessionOwnedMobileTerminals']
  >

  protected abstract toMobileSessionTabsFrame(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['toMobileSessionTabsFrame']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['toMobileSessionTabsFrame']>

  protected abstract toMobileSessionTabsFrames(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['toMobileSessionTabsFrames']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['toMobileSessionTabsFrames']>

  protected abstract waitForSessionTabsInventoryPublication(
    ...args: Parameters<
      SessionTabsInventoryPublicationMethods['waitForSessionTabsInventoryPublication']
    >
  ): ReturnType<SessionTabsInventoryPublicationMethods['waitForSessionTabsInventoryPublication']>

  // Graph changes can alter projected handles/titles without changing snapshot bytes; compare projection fields and fan out affected workspaces.
  protected collectMobileVisibleGraphChangedWorktrees(
    previousTabs: ReadonlyMap<string, RuntimeSyncedTab>,
    previousLeaves: ReadonlyMap<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = visibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves,
      this.tabs,
      this.leaves
    )
    return changed
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string,
    options?: { includeInitialSurfaceLaunch?: true; includeAgentSenders?: boolean }
  ): Promise<RuntimeMobileSessionTabsResult> {
    return (
      await this.listMobileSessionTabsWithChangeSequence(
        worktreeSelector,
        clientNavigationId,
        options
      )
    ).snapshot
  }

  async listMobileSessionTabsWithChangeSequence(
    worktreeSelector: string,
    clientNavigationId?: string,
    options?: { includeInitialSurfaceLaunch?: true; includeAgentSenders?: boolean }
  ): Promise<{ snapshot: RuntimeMobileSessionTabsResult; changeSequence: number }> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.refreshMobileSessionPtyRecords(explicitWorktreeId)
      // Refresh may find surviving PTYs under the host's original path spelling.
      const resolvedId =
        this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ?? explicitWorktreeId
      this.restoreLivePairedRendererSessionOwnedMobileTerminals(resolvedId)
      return this.getMobileSessionTabsForWorktreeWithChangeSequence(
        resolvedId,
        clientNavigationId,
        options
      )
    }
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.refreshMobileSessionPtyRecords()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    return this.getMobileSessionTabsForWorktreeWithChangeSequence(
      worktree.id,
      clientNavigationId,
      options
    )
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string,
    options?: { includeAgentSenders?: boolean }
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return (await this.listAllMobileSessionTabsWithChangeSequence(clientNavigationId, options))
      .snapshots
  }

  async listAllMobileSessionTabsWithChangeSequence(
    clientNavigationId?: string,
    options?: { includeAgentSenders?: boolean }
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    const inventory = await this.collectAllMobileSessionTabs(clientNavigationId, options)
    return { snapshots: inventory.snapshots, changeSequence: inventory.changeSequence }
  }

  protected async collectAllMobileSessionTabs(
    clientNavigationId?: string,
    options?: { includeAgentSenders?: boolean }
  ): Promise<{
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
    const changeSequence = this.mobileSessionTabsChangeSequence
    const snapshots = (
      await this.toMobileSessionTabsFrames(
        this.mobileSessionTabsByWorktree.values(),
        options?.includeAgentSenders
      )
    ).map((frame) => this.projectMobileSessionTabsForClient(frame, clientNavigationId))
    return { snapshots, ptyInventory, changeSequence }
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal,
    options?: { includeAgentSenders?: boolean }
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    const { snapshots, authoritative } =
      await this.listAllMobileSessionTabsInventoryWithChangeSequence(
        clientNavigationId,
        signal,
        options
      )
    return { snapshots, ...(authoritative ? { authoritative } : {}) }
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal,
    options?: { includeAgentSenders?: boolean }
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    this.assertSessionTabsInventoryRequestActive(signal)
    const primedPublicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
    const primed = await this.collectAllMobileSessionTabs(clientNavigationId, options)
    this.assertSessionTabsInventoryRequestActive(signal)
    if (
      primedPublicationEpoch !== null &&
      this.getAuthoritativeSessionTabsInventoryEpoch() === primedPublicationEpoch
    ) {
      return await this.settleSessionTabsInventory(primed, clientNavigationId, signal, options)
    }
    while (true) {
      const publicationEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
      if (publicationEpoch === null) {
        await this.waitForSessionTabsInventoryPublication(signal)
        continue
      }
      const inventory = await this.collectAllMobileSessionTabs(clientNavigationId, options)
      this.assertSessionTabsInventoryRequestActive(signal)
      if (this.getAuthoritativeSessionTabsInventoryEpoch() === publicationEpoch) {
        return await this.settleSessionTabsInventory(inventory, clientNavigationId, signal, options)
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
    signal?: AbortSignal,
    options?: { includeAgentSenders?: boolean }
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
    const retried = await this.collectAllMobileSessionTabs(clientNavigationId, options)
    this.assertSessionTabsInventoryRequestActive(signal)
    return { snapshots: retried.snapshots, changeSequence: retried.changeSequence }
  }

  supportsAuthoritativeSessionTabsInventory(): boolean {
    return process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1'
  }

  protected abstract assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void
  protected abstract isCompleteSessionTabsPtyCensus(
    inventory: PtyControllerInventory | null
  ): boolean
}
