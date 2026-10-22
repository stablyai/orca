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

export abstract class OrcaRuntimeWithMainLayoutTabMoves extends OrcaRuntimeWithMainLayoutRenames {
  protected abstract toMobileSessionTabsResult(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']
    >
  ): ReturnType<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']>

  /**
   * The move in main's layout, read against the rows the client was shown. Null when main does not
   * own the workspace or cannot read the move: today's path moves it, or refuses it with its codes.
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
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    const workspace = hostId
      ? this.workspaceLayoutReads.readPartition(hostId)?.layout.workspaces[worktreeId]
      : undefined
    if (!workspace) {
      throw new Error('tab_not_found')
    }
    const rows = this.toMobileSessionTabsResult(shown)
    // A group showing a tab main's layout lacks (a diff, a preview) moves as today, and so does a
    // move main cannot read as one: today's path checks it against those rows and answers.
    // Bridge (ledger L280): goes once main's layout holds every tab a group shows.
    const groupsHeld = (rows.tabGroups ?? [])
      .filter((group) => group.id === move.targetGroupId || group.tabOrder.includes(move.tabId))
      .every((group) => group.tabOrder.every((rowId) => resolveSessionTabRow(workspace, rowId)))
    const translation = groupsHeld
      ? translateSessionTabMove(worktreeId, workspace, rows, move)
      : null
    if (!translation?.ok) {
      return null
    }
    for (const command of translation.commands) {
      if (command.type !== 'moveTab' && command.type !== 'splitGroup') {
        throw new Error('invalid_params')
      }
      const reply = await this.applyLayoutCommand(command)
      if (!reply.ok) {
        throw new Error(reply.code === 'group_not_found' ? 'target_group_not_found' : reply.code)
      }
    }
    return { moved: true }
  }
}
