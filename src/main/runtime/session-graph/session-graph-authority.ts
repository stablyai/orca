import type { BrowserWindow } from 'electron'
import { getRuntimeDesktopSurface } from '../construction/runtime-desktop-surface'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../shared/preflight-runtime-capabilities'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree as ResolveBrowserNetworkExecutionHostForWorktreeMethods } from '../terminal/launch/terminal-workspace-scope'
import { OrcaRuntimeWithHasTerminalsForWorktree } from './session-graph-reload-lifecycle'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import {
  assertFolderWorkspacePathUsable,
  getResolvedFolderWorkspacePathStatus,
  inferFolderWorkspacePathConnection
} from '../../project-groups/folder-workspace-path-status'
import {
  blockedWslDistroForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../../wsl/filesystem/wsl-unc-access-gate'
import { wslDistroHoldMessage } from '../../../shared/wsl-distro-stopped-hold'
import type { TerminalWorkspaceLaunchScope } from '../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderCatalogOf,
  resolveKeyedFolderWorkspace,
  type WorkspaceSelectorOptions
} from '../workspaces/catalog/workspace-selector-candidates'
import type { ResolvedWorktree } from '../workspaces/catalog/runtime-worktree-path-identity'

export abstract class OrcaRuntimeWithTransitionGraphReloadToTerminalState extends OrcaRuntimeWithHasTerminalsForWorktree {
  getAuthoritativeWindow(missingWindowMessage = 'No renderer window available'): BrowserWindow {
    const win = this.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      throw new Error(missingWindowMessage)
    }
    return win
  }

  protected getAvailableAuthoritativeWindow(): BrowserWindow | null {
    if (this.authoritativeWindowId === null) {
      return null
    }
    const win = getRuntimeDesktopSurface().findWindowById(this.authoritativeWindowId)
    return win && !win.isDestroyed() ? win : null
  }

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
    this.terminalIdentity.clearTabs()
    this.terminalIdentity.clearLeaves()
    this.leavesByPtyId.clear()
    this.terminalIdentity.clearHandles()
    this.terminalIdentity.clearLeafBindings()
    this.clearPtyIncarnationHandles()
    this.terminalWaiters.rejectAll('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  protected shouldRestoreHeadlessGraph(windowId: number): boolean {
    return windowId !== HEADLESS_RUNTIME_WINDOW_ID && this.headlessGraphFallbackAvailable
  }

  protected restoreHeadlessGraphAuthority(): void {
    this.terminalIdentity.advanceRendererEpoch()
    this.authoritativeWindowId = HEADLESS_RUNTIME_WINDOW_ID
    this.graphStatus = 'ready'
    this.rendererGeneration = null
    this.setTerminalSideEffectConsumerAvailable(false)
    this.terminalIdentity.clearTabs()
    this.terminalIdentity.clearLeaves()
    this.leavesByPtyId.clear()
    this.terminalIdentity.clearHandles()
    this.terminalIdentity.clearLeafBindings()
    this.clearPtyIncarnationHandles()
    this.terminalWaiters.rejectAll('terminal_handle_stale')
    this.refreshWritableFlags()
    this.markSessionTabsInventoryPublished()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      this.headlessGraphFallbackAvailable = true
      startedMainTerminalSurfaces(this)?.republish({ force: true })
    }
  }

  /** A reloading graph keeps main-created tabs; only an unavailable one cannot hold a run terminal. */
  canOpenRunTerminals(): boolean {
    return this.graphStatus !== 'unavailable'
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
    return resolveKeyedFolderWorkspace(folderCatalogOf(this.store), selector, requiredHostId)
  }

  /** Folder workspaces first, then Git worktrees; project-group folders have no repo row (STA-12562). Launching needs the folder on disk; teardown must not. */
  protected async resolveWorkspaceSelector(
    selector: string,
    options: WorkspaceSelectorOptions = {}
  ): Promise<ResolvedWorktree> {
    const candidate = await this.resolveWorkspaceCandidate(selector, options)
    if (candidate.kind === 'worktree') {
      return candidate.worktree
    }
    const folderWorkspace = options.requireUsableFolderPath
      ? (
          await this.resolveFolderWorkspaceLaunchScope(
            folderWorkspaceKey(candidate.folder.id),
            {},
            candidate.folder
          )
        )?.folderWorkspace
      : candidate.folder
    if (!folderWorkspace) {
      throw new Error('selector_not_found')
    }
    return this.folderWorkspaceToResolvedWorktree(folderWorkspace)
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
}
