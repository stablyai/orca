import { resolveQualifiedFolderWorkspaceResult } from '../../../shared/folder-workspace-execution-host'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../shared/protocol-version'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree as ResolveBrowserNetworkExecutionHostForWorktreeMethods } from '../terminal/launch/terminal-workspace-scope'
import { OrcaRuntimeWithHasTerminalsForWorktree } from './session-graph-reload-lifecycle'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  assertFolderWorkspacePathUsable,
  getResolvedFolderWorkspacePathStatus,
  inferFolderWorkspacePathConnection
} from '../../project-groups/folder-workspace-path-status'
import {
  blockedWslDistroForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../../wsl/wsl-unc-access-gate'
import { wslDistroHoldMessage } from '../../../shared/wsl-distro-stopped-hold'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { BrowserExecutionHostKeyResolution } from '../runtime-browser-client-page-adoption'
import { browserNetworkExecutionHostKey } from '../../browser/browser-network-execution-route'
import type { ClientHostedBrowserRpcRoute } from '../runtime-browser-client-automation'
import { routeRuntimeBrowserClientAutomation } from '../runtime-browser-client-automation'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry-instance'
import {
  routeDesktopBrowserBridgeRpc,
  type DesktopBrowserBridgeRoute
} from '../desktop-browser-bridge/desktop-browser-bridge-route'
import {
  getDesktopBrowserBridgeRegistry,
  isDesktopBrowserBridgeHostEnabled
} from '../desktop-browser-bridge/desktop-browser-bridge-registry'
import { runtimeBrowserCommandsFactoryIsAvailable } from '../runtime-browser-commands-factory'
import { hasPairedPageHost } from '../browser/browser-client-page-opening'
import { resolveRemoteCliBrowserScopeSelector } from '../desktop-browser-bridge/remote-cli-browser-scope'
import type { RpcContext } from '../rpc/core'

export abstract class OrcaRuntimeWithTransitionGraphReloadToTerminalState extends OrcaRuntimeWithHasTerminalsForWorktree {
  protected abstract resolveBrowserNetworkExecutionHostForWorktree(
    ...args: Parameters<
      ResolveBrowserNetworkExecutionHostForWorktreeMethods['resolveBrowserNetworkExecutionHostForWorktree']
    >
  ): ReturnType<
    ResolveBrowserNetworkExecutionHostForWorktreeMethods['resolveBrowserNetworkExecutionHostForWorktree']
  >

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
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      this.headlessGraphFallbackAvailable = true
      startedMainTerminalSurfaces(this)?.republish({ force: true })
    }
  }

  assertGraphReady(): void {
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

  /** `wslUserAct`: the user's start, so its folder check may start a stopped WSL distro (E9). */
  protected async resolveFolderWorkspaceLaunchScope(
    selector: string,
    options: { wslUserAct?: boolean } = {},
    resolvedFolder?: FolderWorkspace,
    checkPath = true
  ): Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null> {
    const workspace = resolvedFolder ?? this.resolveFolderWorkspaceSelector(selector)
    if (!workspace) {
      return null
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const host = parseExecutionHostId(workspace.executionHostId)
    if (resolvedFolder && host?.kind === 'runtime' && checkPath) {
      throw new Error(WORKSPACE_ON_OTHER_RUNTIME)
    }
    const connectionId = getRepoSshConnectionId(workspace)
    if (checkPath) {
      const readStatus = () =>
        getResolvedFolderWorkspacePathStatus(workspace, getRepoExecutionHostId(workspace))
      if (options.wslUserAct) {
        assertFolderWorkspacePathUsable(
          await runAsWslUserAct(wslDistroForPath(workspace.folderPath), readStatus)
        )
      } else {
        // Background work holds with Start, before any physical folder check.
        const blocked = await blockedWslDistroForPath(workspace.folderPath)
        if (blocked) {
          throw new Error(wslDistroHoldMessage(blocked.distro, blocked.state))
        }
        assertFolderWorkspacePathUsable(await readStatus())
      }
    }
    return {
      id: folderWorkspaceKey(workspace.id),
      path: workspace.folderPath,
      connectionId,
      repo: null,
      folderWorkspace: workspace
    }
  }

  protected resolveFolderWorkspaceSelector(
    selector: string,
    requiredHostId?: ExecutionHostId
  ): FolderWorkspace | null {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    if (parsed?.type !== 'folder') {
      return null
    }
    const result = resolveQualifiedFolderWorkspaceResult(
      {
        folderWorkspaces: this.store?.getFolderWorkspaces?.() ?? [],
        projectGroups: this.store?.getProjectGroups?.() ?? [],
        repos: this.store?.getRepos() ?? []
      },
      parsed.folderWorkspaceId,
      requiredHostId
    )
    if (result.kind !== 'selected') {
      throw new Error(result.kind === 'missing' ? 'selector_not_found' : 'selector_ambiguous')
    }
    const selected = result.value
    return {
      ...selected.workspace,
      executionHostId: selected.hostId,
      connectionId: selected.connectionId
    }
  }

  /** Folder workspaces first, then Git worktrees; project-group folders have no repo row (STA-12562). Launching needs the folder on disk; teardown must not. */
  protected async resolveWorkspaceSelector(
    selector: string,
    options: { requireUsableFolderPath?: boolean; requiredHostId?: ExecutionHostId } = {}
  ): Promise<ResolvedWorktree> {
    const selectedFolder = this.resolveFolderWorkspaceSelector(selector, options.requiredHostId)
    const folderWorkspace = options.requireUsableFolderPath
      ? (await this.resolveFolderWorkspaceLaunchScope(selector, {}, selectedFolder ?? undefined))
          ?.folderWorkspace
      : selectedFolder
    return folderWorkspace
      ? this.folderWorkspaceToResolvedWorktree(folderWorkspace)
      : this.resolveGitWorktreeSelector(selector, options.requiredHostId)
  }

  protected async resolveEmulatorWorkspaceId(selector: string): Promise<string> {
    const key = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(key)
    // Emulator association needs a unique folder identity, not a physical launch host.
    if (parsed?.type === 'folder') {
      const rows =
        this.store
          ?.getFolderWorkspaces?.()
          .filter((workspace) => workspace.id === parsed.folderWorkspaceId) ?? []
      if (rows.length !== 1) {
        throw new Error(rows.length ? 'selector_ambiguous' : 'selector_not_found')
      }
      return folderWorkspaceKey(rows[0].id)
    }
    return (await this.resolveWorkspaceSelector(selector)).id
  }

  protected resolveBrowserWorkspace(selector: string): Promise<ResolvedWorktree> {
    return this.resolveWorkspaceSelector(selector, { requireUsableFolderPath: true })
  }

  /** Reconcile client-hosted pages per paired device; one attached client cannot account for another's pages. */
  markClientHostedPagesReconciled(pairedDeviceId: string): void {
    this.clientHostedPageReconciliation.markReconciled(pairedDeviceId)
  }

  /** Resolve the current host key; native/WSL runtime ids and SSH provider epochs expire on restart. Missing workspaces are gone; reconnect/repair is temporary and never authorizes page retirement. */
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
      resolveWorkspace: (selector) =>
        resolveRemoteCliBrowserScopeSelector(selector) ?? this.resolveBrowserWorkspace(selector)
    })
  }

  /** On orcad, sends this host's CLI browser commands to the desktop that opted in to serve them. */
  routeDesktopBrowserBridgeRpc(
    method: string,
    params: unknown,
    context: Pick<RpcContext, 'caller' | 'signal'>
  ): Promise<DesktopBrowserBridgeRoute> {
    return routeDesktopBrowserBridgeRpc({
      method,
      params,
      caller: context.caller,
      signal: context.signal,
      hostEnabled: isDesktopBrowserBridgeHostEnabled(),
      registry: getDesktopBrowserBridgeRegistry(this),
      // This runtime lists/retires desktop-hosted pages even while their desktop is gone, so those commands need no bridge.
      localBrowserAvailable:
        runtimeBrowserCommandsFactoryIsAvailable() ||
        getRuntimeBrowserPageRegistry(this).listPages().length > 0 ||
        hasPairedPageHost({ getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this) }),
      resolveWorkspace: (selector) => this.resolveBrowserWorkspace(selector)
    })
  }
}
