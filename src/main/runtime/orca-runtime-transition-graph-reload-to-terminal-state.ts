// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithHasTerminalsForWorktree } from './orca-runtime-has-terminals-for-worktree'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  inferFolderWorkspacePathConnection
} from '../project-groups/folder-workspace-path-status'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import type { ClientHostedBrowserRpcRoute } from './runtime-browser-client-automation'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'

export class OrcaRuntimeWithTransitionGraphReloadToTerminalState extends OrcaRuntimeWithHasTerminalsForWorktree {
  protected transitionGraphReloadToTerminalState(windowId: number): void {
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return
    }
    this.graphStatus = 'unavailable'
    this.setTerminalSideEffectConsumerAvailable(false)
    this.rememberDetachedPreAllocatedLeaves()
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.clearPtyIncarnationHandles()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  protected shouldRestoreHeadlessGraph(windowId: number): boolean {
    return windowId !== HEADLESS_RUNTIME_WINDOW_ID && this.headlessGraphFallbackAvailable
  }

  protected restoreHeadlessGraphAuthority(): void {
    this.rendererGraphEpoch += 1
    this.authoritativeWindowId = HEADLESS_RUNTIME_WINDOW_ID
    this.graphStatus = 'ready'
    this.rendererGeneration = null
    this.setTerminalSideEffectConsumerAvailable(false)
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.clearPtyIncarnationHandles()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
    this.markSessionTabsInventoryPublished()
  }

  protected assertGraphReady(): void {
    if (this.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  protected captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.rendererGraphEpoch
  }

  protected assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (this.graphStatus !== 'ready' || this.rendererGraphEpoch !== expectedGraphEpoch) {
      throw new Error('runtime_unavailable')
    }
  }

  protected resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null {
    const repos = this.store?.getRepos() ?? []
    const projectGroups = this.store?.getProjectGroups?.() ?? []
    const connection = inferFolderWorkspacePathConnection({
      folderPath: workspace.folderPath,
      projectGroupId: workspace.projectGroupId,
      connectionId: workspace.connectionId ?? null,
      projectGroups,
      repos
    })
    if (connection.kind === 'ambiguous') {
      // Why: a PTY spawns on one runtime target; mixed child-repo connections need an explicit V2 routing decision.
      throw new Error('folder_workspace_connection_ambiguous')
    }
    return connection.kind === 'ssh' ? connection.connectionId : null
  }

  protected async resolveFolderWorkspaceLaunchScope(
    selector: string
  ): Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null> {
    const workspace = this.resolveFolderWorkspaceSelector(selector)
    if (!workspace) {
      return null
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const status = await getFolderWorkspacePathStatus(
      this.store,
      { scope: 'folder-workspace', folderWorkspaceId: workspace.id },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
    return {
      id: folderWorkspaceKey(workspace.id),
      path: workspace.folderPath,
      connectionId: this.resolveFolderWorkspaceConnectionId(workspace),
      repo: null,
      folderWorkspace: workspace
    }
  }

  protected resolveFolderWorkspaceSelector(selector: string): FolderWorkspace | null {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    if (parsed?.type !== 'folder') {
      return null
    }
    const workspace = this.store
      ?.getFolderWorkspaces?.()
      .find((entry) => entry.id === parsed.folderWorkspaceId)
    if (!workspace) {
      throw new Error('selector_not_found')
    }
    return workspace
  }

  protected async resolveEmulatorWorkspaceId(selector: string): Promise<string> {
    const folderWorkspace = this.resolveFolderWorkspaceSelector(selector)
    return folderWorkspace
      ? folderWorkspaceKey(folderWorkspace.id)
      : (await this.resolveWorktreeSelector(selector)).id
  }

  protected async resolveBrowserWorkspace(selector: string): Promise<ResolvedWorktree> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    return folderScope?.folderWorkspace
      ? this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      : this.resolveWorktreeSelector(selector)
  }

  /**
   * Closes the window in which snapshots warn that this client's client-hosted pages are still
   * unaccounted for. Keyed by paired device because one client attaching says nothing about another.
   */
  markClientHostedPagesReconciled(pairedDeviceId: string): void {
    this.clientHostedPageReconciliation.markReconciled(pairedDeviceId)
  }

  /**
   * The execution-host key a client-hosted page in this workspace would be created under now.
   *
   * Adoption cannot reuse the key an inventory entry reports: native and WSL keys name the runtime
   * that minted them, and an SSH key carries a per-process provider epoch, so a restart always
   * invalidates them.
   *
   * The two failure modes are not the same answer. A workspace that no longer resolves is gone and
   * its pages have nothing left to be restored into; an execution host that is merely not up yet --
   * an SSH provider mid-reconnect, a project runtime still repairing -- is a "not now", and must
   * never be read as permission to retire the page.
   */
  async resolveBrowserExecutionHostKeyForWorkspace(
    workspaceId: string
  ): Promise<BrowserExecutionHostKeyResolution> {
    let worktree: ResolvedWorktree
    try {
      worktree = await this.resolveBrowserWorkspace(`id:${workspaceId}`)
    } catch {
      return { status: 'workspace-gone' }
    }
    try {
      return {
        status: 'resolved',
        executionHostKey: browserNetworkExecutionHostKey(
          await this.resolveBrowserNetworkExecutionHostForWorktree(worktree)
        )
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  routeClientHostedBrowserRpc(
    method: string,
    params: unknown
  ): Promise<ClientHostedBrowserRpcRoute> {
    return routeRuntimeBrowserClientAutomation({
      method,
      params,
      pages: getRuntimeBrowserPageRegistry(this),
      leases: getBrowserHostLeaseRegistry(this),
      resolveWorkspace: (selector) => this.resolveBrowserWorkspace(selector)
    })
  }
}
