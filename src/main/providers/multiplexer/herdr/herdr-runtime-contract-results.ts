import type {
  HerdrPane,
  HerdrPaneLayoutSnapshot,
  HerdrTab,
  HerdrWorkspace,
  HerdrAgentStatus,
  HerdrAgentInfo
} from './herdr-runtime-contract'

export type HerdrPaneZoomResult = {
  changed: boolean
  zoom_changed: boolean
  focus_changed: boolean
  pane_id: string
  focused_pane_id: string
  zoomed: boolean
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrPaneSwapResult = {
  changed: boolean
  source_pane_id: string
  target_pane_id: string | null
  focused_pane_id: string
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrPaneMoveResult = {
  changed: boolean
  pane: HerdrPane
  previous_pane_id: string
  previous_tab_id: string
  previous_workspace_id: string
  focused_pane_id: string
  created_tab?: HerdrTab | null
  created_workspace?: HerdrWorkspace | null
  closed_tab_id?: string | null
  closed_workspace_id?: string | null
}

export type HerdrPaneResizeResult = {
  changed: boolean
  pane_id: string
  focused_pane_id: string
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrPaneFocusDirectionResult = {
  changed: boolean
  focused_pane_id: string
  pane_id: string | null
}

export type HerdrNotificationShowResult = {
  shown: boolean
  reason: 'shown' | 'disabled' | 'rate_limited' | 'no_foreground_client' | 'busy'
}

export type HerdrAgentListResult = {
  agents: HerdrAgentInfo[]
}

export type HerdrAgentReadResult = {
  read: {
    text: string
    revision: number
    truncated?: boolean
    source?: string
  }
}

export type HerdrAgentExplainResult = {
  agent: string
  final_state: HerdrAgentStatus
  manifest?: { source?: string; version?: string }
  skip_reason?: string
}

export type HerdrOutputMatchedResult = {
  matched_line: string
  pane_id: string
  read: HerdrAgentReadResult['read']
  revision: number
}

export type HerdrPaneNeighborResult = {
  direction: 'left' | 'right' | 'up' | 'down'
  neighbor_pane_id: string | null
  pane_id: string
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrPaneEdgesResult = {
  pane_id: string
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrLayoutNode = {
  type: 'pane' | 'split'
  pane_id?: string | null
  label?: string | null
  cwd?: string | null
  command?: string[] | null
  env?: Record<string, string>
  direction?: 'right' | 'down'
  ratio?: number
  first?: HerdrLayoutNode
  second?: HerdrLayoutNode
}

export type HerdrLayoutExportResult = {
  root: HerdrLayoutNode
}

export type HerdrLayoutApplyResult = {
  layout: HerdrPaneLayoutSnapshot
  tab_id?: string
  workspace_id?: string
}

export type HerdrLayoutSetSplitRatioResult = {
  layout: HerdrPaneLayoutSnapshot
}

export type HerdrEventEnvelope = {
  seq: number
  event: {
    type: string
    workspace_id?: string
    tab_id?: string
    pane_id?: string
    agent?: string | null
    agent_status?: HerdrAgentStatus
    label?: string | null
    min_revision?: number
  }
}

export type HerdrEventsSubscribeResult = {
  subscription_id: string
}

export type HerdrEventsWaitResult = {
  event: HerdrEventEnvelope
}

export type HerdrWorktreeInfo = {
  workspace_id: string
  label: string
  worktree: {
    repo_key: string
    repo_name: string
    repo_root: string
    checkout_path: string
    is_linked_worktree: boolean
  }
}

export type HerdrWorktreeListResult = {
  worktrees: HerdrWorktreeInfo[]
}

export type HerdrServerLiveHandoffResult = {
  handed_off: boolean
}

export type HerdrPingResult = {
  pong: string
  protocol: number
  version: string
}
