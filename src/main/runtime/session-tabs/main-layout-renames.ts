// Main-owned terminal names/props use layout commands for every view; null/false retains legacy routing for other workspaces.
import type { OrcaRuntimeWithPersistHeadlessTerminalTitle as PersistHeadlessTerminalTitleMethods } from '../workspaces/workspace-file-session-targets'
import { OrcaRuntimeWithMainLayoutAgentLaunchTabs } from './main-layout-agent-launch-tabs'
import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../shared/runtime-terminal-contracts'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { translateSetTabProps } from '../../../shared/workspace-layout/old-client/old-client-method-translation'
import { resolveSessionTabRow } from '../../../shared/workspace-layout/old-client/old-client-session-tab-rows'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import { paneTitlesForDesktopWindow } from './desktop-pane-title-forwarding'

type MainOwnedPane = {
  worktreeId: string
  tabId: string
  leafId: string
  pty: RuntimePtyWorktreeRecord | null
}

export type PaneLayoutEdit = {
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  chatLeafId?: string | null
  titlesByLeafId?: Record<string, string>
  renamedLeafIds?: string[]
}

export abstract class OrcaRuntimeWithMainLayoutRenames extends OrcaRuntimeWithMainLayoutAgentLaunchTabs {
  protected abstract persistHeadlessTerminalTitle(
    ...args: Parameters<PersistHeadlessTerminalTitleMethods['persistHeadlessTerminalTitle']>
  ): ReturnType<PersistHeadlessTerminalTitleMethods['persistHeadlessTerminalTitle']>

  protected abstract resolveMobileSessionHostTabId(
    ...args: Parameters<PersistHeadlessTerminalTitleMethods['resolveMobileSessionHostTabId']>
  ): ReturnType<PersistHeadlessTerminalTitleMethods['resolveMobileSessionHostTabId']>

  /** The pane a handle names in main's layout: its live terminal's pane, else the graph's. */
  private mainOwnedPaneOfHandle(handle: string): MainOwnedPane | null {
    const surfaces = startedMainTerminalSurfaces(this)
    if (!surfaces) {
      return null
    }
    // The graph takes main's latest panes first, so a handle names what main holds now.
    surfaces.republish()
    const pty = this.getLivePtyForHandle(handle)?.pty ?? null
    // getLiveLeafForHandle checks the graph is ready first, so a reload fails as today's rename.
    const pane = pty ? surfaces.findPaneForPty(pty.ptyId) : this.getLiveLeafForHandle(handle).leaf
    return pane &&
      surfaces.ownsWorkspace(pane.worktreeId) &&
      surfaces.panesOfTab(pane.tabId).some((entry) => entry.leafId === pane.leafId)
      ? { worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId, pty }
      : null
  }

  /** Main's layout of a workspace, from its routed partition; undefined when main holds none. */
  protected mainLayoutWorkspace(worktreeId: string): WorkspaceLayout | undefined {
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId
      ? this.workspaceLayoutReads.readPartition(hostId)?.layout.workspaces[worktreeId]
      : undefined
  }

  /** The tab main's layout lists a row under (a chat row's id is not its tab's), if it holds it. */
  protected mainLayoutTabOfRow(worktreeId: string, rowId: string | undefined): string | undefined {
    const workspace = rowId ? this.mainLayoutWorkspace(worktreeId) : undefined
    return workspace && rowId ? resolveSessionTabRow(workspace, rowId)?.tab.id : undefined
  }

  /** A client's command acts only while each row it named still names, in main's layout when the
   *  store runs the write, the tab it named when translated: a queued switch or an earlier command
   *  of the same reorder can change what a tab holds before the write runs. */
  protected rowAdmission(
    worktreeId: string,
    translated: WorkspaceLayout,
    rowIds: readonly string[]
  ): LayoutCommandRunOptions {
    const named = rowIds.flatMap((rowId) => {
      const tabId = resolveSessionTabRow(translated, rowId)?.tab.id
      return tabId ? [[rowId, tabId] as const] : []
    })
    return {
      admit: () =>
        named.every(([rowId, tabId]) => this.mainLayoutTabOfRow(worktreeId, rowId) === tabId)
    }
  }

  /** The tab's panes when main's layout holds it as a terminal tab of an owned workspace. */
  private mainOwnedTabPanes(worktreeId: string, tabId: string) {
    const surfaces = startedMainTerminalSurfaces(this)
    const panes = surfaces?.ownsWorkspace(worktreeId) ? surfaces.panesOfTab(tabId) : []
    return panes.length > 0 ? panes : null
  }

  private async applyMainRename(
    command: WindowLayoutCommand,
    run?: LayoutCommandRunOptions
  ): Promise<void> {
    const reply = await this.applyLayoutCommand(command, run)
    if (!reply.ok) {
      // A pane a concurrent close took is a stale handle, as today's rename of it is.
      throw new Error(
        reply.code === 'tab_not_found' || reply.code === 'pane_not_found'
          ? 'terminal_handle_stale'
          : reply.code
      )
    }
  }

  /** A manual name outranks later agent titles, which win by timestamp, so it is the freshest. */
  private stampManualTitle(pty: RuntimePtyWorktreeRecord, title: string | null): void {
    pty.title = title
    const observedAtEpochMs = Date.now()
    pty.titleUpdatedAt = observedAtEpochMs
    pty.titleObservedAtEpochMs = title ? observedAtEpochMs : null
    this.touchMobileSessionSnapshotsForPty(pty.ptyId)
  }

  /** `terminal.rename` of a terminal main owns: names its tab in main's layout. */
  protected async renameTerminalInMainLayout(
    handle: string,
    title: string | null
  ): Promise<RuntimeTerminalRename | null> {
    const pane = this.mainOwnedPaneOfHandle(handle)
    if (!pane) {
      return null
    }
    // As today's rename: the name stored, set on the terminal and answered is the one asked for.
    const written = title || null
    if (pane.pty) {
      this.stampManualTitle(pane.pty, written)
    }
    await this.applyMainRename({
      type: 'renameTab',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      kind: 'custom',
      title: written
    })
    return { handle, tabId: pane.tabId, title: written }
  }

  /** `terminal.setPaneTitle` of a pane main owns: names that pane in main's layout. */
  protected async setPaneTitleInMainLayout(
    handle: string,
    title: string | null
  ): Promise<RuntimeTerminalSetPaneTitle | null> {
    const pane = this.mainOwnedPaneOfHandle(handle)
    if (!pane) {
      return null
    }
    const normalizedTitle = title?.trim() || null
    await this.applyMainRename({
      type: 'renamePane',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      title: normalizedTitle
    })
    return { handle, tabId: pane.tabId, leafId: pane.leafId, title: normalizedTitle }
  }

  /** A phone's tab props for a terminal tab main owns; false for any other tab. The row names
   *  the layout tab (which a switch keeps while its terminal changes); the terminal id names only
   *  the terminal's panes. */
  protected async setMainTabProps(
    worktreeId: string,
    rowId: string,
    terminalTabId: string,
    props: {
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      customTitle?: string | null
    }
  ): Promise<boolean> {
    const panes = this.mainOwnedTabPanes(worktreeId, terminalTabId)
    const workspace = panes ? this.mainLayoutWorkspace(worktreeId) : undefined
    if (!panes || !workspace) {
      return false
    }
    const translated = translateSetTabProps(worktreeId, workspace, { tabId: rowId })
    const tabId =
      translated.ok && translated.commands[0]?.type === 'setTabProps'
        ? translated.commands[0].tabId
        : null
    if (!tabId) {
      throw new Error('terminal_handle_stale')
    }
    const admission = this.rowAdmission(worktreeId, workspace, [rowId])
    const { customTitle, color, isPinned, viewMode } = props
    const tabProps = { color, isPinned, viewMode }
    if (Object.values(tabProps).some((value) => value !== undefined)) {
      await this.applyMainRename(
        { type: 'setTabProps', workspace: worktreeId, tabId, ...tabProps },
        admission
      )
    }
    if (customTitle !== undefined) {
      // Why by tab: a sleeping or starting pane has no handle for terminal.rename to name (#29975).
      const title = customTitle?.trim() || null
      for (const { ptyId } of panes) {
        const pty = ptyId ? this.ptysById.get(ptyId) : undefined
        if (pty) {
          this.stampManualTitle(pty, title)
        }
      }
      await this.applyMainRename(
        { type: 'renameTab', workspace: worktreeId, tabId, kind: 'custom', title },
        admission
      )
    }
    return true
  }

  /** Rename only client-declared changed panes; resent maps may predate host names. Return remaining edits. */
  protected async nameMainPanes(
    worktreeId: string,
    tabId: string,
    edit: PaneLayoutEdit
  ): Promise<PaneLayoutEdit> {
    if (!this.mainOwnedTabPanes(worktreeId, tabId)) {
      return edit
    }
    const { titlesByLeafId, renamedLeafIds, ...geometry } = edit
    const renamed = new Set(renamedLeafIds)
    const tab = this.getWorkspaceSessionForWorktree(worktreeId)?.tabsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === tabId
    )
    const titles = titlesByLeafId
      ? paneTitlesForDesktopWindow({ root: edit.root, titlesByLeafId, tab })
      : []
    for (const { leafId, title } of titles.filter((entry) => renamed.has(entry.leafId))) {
      await this.applyMainRename({
        type: 'renamePane',
        workspace: worktreeId,
        tabId,
        leafId,
        title
      })
    }
    return geometry
  }
}
