import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type WorkspaceLayoutPartition = { hostId: ExecutionHostId; session: WorkspaceSessionState }

export type WorkspaceLayoutRule =
  | 'terminal_in_two_panes'
  | 'pane_in_two_tabs'
  | 'pane_twice_in_one_tab'
  | 'pane_without_tab'
  | 'binding_without_pane'
  | 'tab_in_two_places'
  | 'tab_bar_missing'
  | 'tab_without_group'
  | 'tab_in_two_groups'
  | 'tab_group_mismatch'
  | 'group_lists_missing_tab'
  | 'tab_lists_disagree'
  | 'tab_order_disagrees'
  | 'pane_id_changed'
  | 'tab_id_changed'
  | 'group_id_changed'

export type WorkspaceLayoutViolation = {
  rule: WorkspaceLayoutRule
  hostId: ExecutionHostId
  worktreeId?: string
  ids: string[]
  detail: string
}
