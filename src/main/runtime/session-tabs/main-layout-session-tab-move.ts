// Layout-owner builds: a phone's or paired client's tab move in a workspace main owns is main's own
// layout command, window or not; every view draws it from main's frames, so the window is not asked.
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { translateSessionTabMove } from '../../../shared/workspace-layout/old-client/old-client-method-translation'
import { resolveSessionTabRow } from '../../../shared/workspace-layout/old-client/old-client-session-tab-rows'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import { OrcaRuntimeWithMainLayoutRenames } from './main-layout-renames'
import { liveTerminalsOfTab } from '../session-lifecycle/close/closed-tab-terminal'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { isPaneColumnSplitDropNoOp } from '../../../shared/workspace-layout/pane-column-split-drop-no-op'

export abstract class OrcaRuntimeWithMainLayoutTabMoves extends OrcaRuntimeWithMainLayoutRenames {
  protected abstract toMobileSessionTabsResult(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']
    >
  ): ReturnType<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']>

  /** A closed tab's rows' live terminals, read before main's close drops their panes. */
  protected liveTerminalsOfClosedTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tabId: string
  ): ReturnType<typeof liveTerminalsOfTab> {
    return liveTerminalsOfTab(snapshot, tabId, (row) =>
      this.findPtyForMobileTerminalTab(worktreeId, row)
    )
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

  /**
   * The move in main's layout, checked against the rows the client was shown and refused with
   * today's codes. Null for a workspace main does not own: today's path moves it.
   */
  protected async moveTabInMainLayout(
    worktreeId: string,
    shown: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult | null> {
    if (
      !ORCA_LAYOUT_OWNER_IS_MAIN ||
      !startedMainTerminalSurfaces(this)?.ownsWorkspace(worktreeId)
    ) {
      return null
    }
    const workspace = this.mainLayoutWorkspace(worktreeId)
    if (!workspace) {
      throw new Error('tab_not_found')
    }
    const translation = translateSessionTabMove(
      worktreeId,
      workspace,
      this.toMobileSessionTabsResult(shown),
      move
    )
    if (!translation.ok) {
      throw new Error(translation.code)
    }
    for (const command of translation.commands) {
      if (command.type !== 'moveTab' && command.type !== 'splitGroup') {
        throw new Error('invalid_params')
      }
      if (command.type === 'splitGroup' && isSplitNoOp(workspace, command)) {
        continue
      }
      const reply = await this.applyLayoutCommand(command)
      if (!reply.ok) {
        throw new Error(reply.code === 'group_not_found' ? 'target_group_not_found' : reply.code)
      }
      if (command.type === 'splitGroup' && reply.result.groupId) {
        this.selectSplitTab(worktreeId, workspace, command.tabId, reply.result.groupId)
      }
    }
    return { moved: true }
  }

  /** As the window's drop: the split tab is selected, and its new group is the active one. */
  private selectSplitTab(
    worktreeId: string,
    workspace: WorkspaceLayout,
    tabId: string,
    groupId: string
  ): void {
    const held = this.mobileSessionTabsByWorktree.get(worktreeId)
    const rows = held?.tabs.filter(
      (row) => resolveSessionTabRow(workspace, row.id)?.tab.id === tabId
    )
    const moved = rows?.find((row) => row.isActive) ?? rows?.[0]
    if (!held || !moved) {
      return
    }
    const stored = this.storeMobileSessionSnapshot(worktreeId, {
      ...held,
      snapshotVersion: held.snapshotVersion + 1,
      activeGroupId: groupId,
      activeTabId: moved.id,
      activeTabType: moved.type,
      tabs: held.tabs.map((row) => ({ ...row, isActive: row.id === moved.id }))
    })
    this.emitMobileSessionTabsSnapshot(stored)
  }
}

/** The window's no-op split (a group's last tab dropped on itself or its neighbour's facing edge). */
function isSplitNoOp(workspace: WorkspaceLayout, command: CommandOf<'splitGroup'>): boolean {
  const source = workspace.groups.find((group) => group.tabOrder.includes(command.tabId))
  return (
    !!source &&
    isPaneColumnSplitDropNoOp({
      sourceGroupId: source.id,
      targetGroupId: command.besideGroupId,
      splitDirection: command.direction,
      sourceTabCount: source.tabOrder.length,
      layout: workspace.groupLayout
    })
  )
}
