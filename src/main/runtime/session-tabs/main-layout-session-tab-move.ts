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
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import { OrcaRuntimeWithMainLayoutRenames } from './main-layout-renames'

export abstract class OrcaRuntimeWithMainLayoutTabMoves extends OrcaRuntimeWithMainLayoutRenames {
  protected abstract toMobileSessionTabsResult(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']
    >
  ): ReturnType<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['toMobileSessionTabsResult']>

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
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    const workspace = hostId
      ? this.workspaceLayoutReads.readPartition(hostId)?.layout.workspaces[worktreeId]
      : undefined
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
      const reply = await this.applyLayoutCommand(command)
      if (!reply.ok) {
        throw new Error(reply.code === 'group_not_found' ? 'target_group_not_found' : reply.code)
      }
    }
    return { moved: true }
  }
}
