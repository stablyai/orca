// Layout-owner builds: naming a terminal tab or pane in a workspace main owns, and setting its tab's
// props, is main's own layout command, window or not; every view draws the change from main's frames.
// Each method answers null or false for any other workspace, which keeps today's path.
import type { OrcaRuntimeWithPersistHeadlessTerminalTitle as PersistHeadlessTerminalTitleMethods } from '../workspaces/workspace-file-session-targets'
import { OrcaRuntimeWithMainLayoutAgentLaunchTabs } from './main-layout-agent-launch-tabs'
import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../shared/runtime-terminal-contracts'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
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

  /** The tab's panes when main's layout holds it as a terminal tab of an owned workspace. */
  private mainOwnedTabPanes(worktreeId: string, tabId: string) {
    const surfaces = startedMainTerminalSurfaces(this)
    const panes = surfaces?.ownsWorkspace(worktreeId) ? surfaces.panesOfTab(tabId) : []
    return panes.length > 0 ? panes : null
  }

  private async applyMainRename(command: WindowLayoutCommand): Promise<void> {
    const reply = await this.applyLayoutCommand(command)
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

  /** A phone's tab props for a terminal tab main owns; false for any other tab. */
  protected async setMainTabProps(
    worktreeId: string,
    tabId: string,
    props: {
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      customTitle?: string | null
    }
  ): Promise<boolean> {
    const panes = this.mainOwnedTabPanes(worktreeId, tabId)
    if (!panes) {
      return false
    }
    const { customTitle, ...tabProps } = props
    if (Object.values(tabProps).some((value) => value !== undefined)) {
      await this.applyMainRename({ type: 'setTabProps', workspace: worktreeId, tabId, ...tabProps })
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
      await this.applyMainRename({
        type: 'renameTab',
        workspace: worktreeId,
        tabId,
        kind: 'custom',
        title
      })
    }
    return true
  }

  /**
   * A phone's pane names in a terminal tab main owns become main's pane renames, only for the panes
   * it says it renamed (a resent map may predate the host's names). Returns the rest of the edit.
   */
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
