import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-list/feed/sidebar-inputs-switch'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import {
  isLastVisitedWorktreeRow,
  type LastVisitedWorktreeOnHost
} from '../worktree/row-presentation/host-list-highlight'

// The feed draws this phone's highlight; the legacy list draws rows as the host sent them.
export const drawBotRow = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? (lastVisited: LastVisitedWorktreeOnHost | null) => (row: Worktree) => ({
      row: { ...row, isActive: isLastVisitedWorktreeRow(row, lastVisited) },
      view: {}
    })
  : () => (row: Worktree) => ({ row, view: {} })
