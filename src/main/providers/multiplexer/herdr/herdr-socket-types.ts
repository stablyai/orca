export type HerdrSocketRequest = {
  id: string
  method: string
  params: unknown
}

export type HerdrSocketResponse = {
  id: string
  result?: unknown
  error?: { code: string; message: string }
}

export type HerdrSocketEvent = {
  event: string
  data: { type: string; [key: string]: unknown }
  sessionName?: string
}

export type HerdrSocketMessage = HerdrSocketResponse | HerdrSocketEvent

export type Subscription = {
  type: string
}

export type EventsSubscribeParams = {
  subscriptions: Subscription[]
}

export type EventsWaitParams = {
  match_event: EventMatch
  timeout_ms?: number
}

export type EventMatch =
  | { event: 'workspace_created'; workspace_id?: string | null }
  | { event: 'workspace_updated'; workspace_id: string }
  | { event: 'workspace_closed'; workspace_id: string }
  | { event: 'workspace_renamed'; workspace_id: string; label?: string | null }
  | { event: 'workspace_moved'; workspace_id: string }
  | { event: 'workspace_focused'; workspace_id: string }
  | { event: 'tab_created'; tab_id?: string | null; workspace_id?: string | null }
  | { event: 'tab_closed'; tab_id: string }
  | { event: 'tab_renamed'; tab_id: string; label?: string | null }
  | { event: 'tab_moved'; tab_id: string }
  | { event: 'tab_focused'; tab_id: string }
  | { event: 'pane_created'; pane_id?: string | null; workspace_id?: string | null }
  | { event: 'pane_closed'; pane_id: string }
  | { event: 'pane_focused'; pane_id: string }
  | { event: 'pane_moved'; pane_id: string }
  | { event: 'pane_output_changed'; min_revision?: number | null; pane_id: string }
  | { event: 'pane_exited'; pane_id: string }
  | { event: 'pane_agent_detected'; pane_id: string; agent?: string | null }
  | { event: 'pane_agent_status_changed'; pane_id: string; agent_status: string }
  | { event: 'pane_scroll_changed'; pane_id: string }
  | { event: 'layout_updated' }
  | {
      event: 'pane.output_matched'
      lines?: number | null
      match: { type: 'substring' | 'regex'; value: string }
      pane_id: string
      source: string
      strip_ansi?: boolean
    }

export type LayoutExportParams = {
  pane_id?: string | null
  tab_id?: string | null
}

export type LayoutExportResult = {
  root: LayoutNode
}

export type LayoutNode = {
  type: 'pane' | 'split'
  pane_id?: string | null
  label?: string | null
  cwd?: string | null
  command?: string[] | null
  env?: Record<string, string>
  direction?: 'right' | 'down'
  ratio?: number
  first?: LayoutNode
  second?: LayoutNode
}

export type LayoutApplyParams = {
  root: LayoutNode
  focus?: boolean
  tab_id?: string | null
  tab_label?: string | null
  workspace_id?: string | null
}

export type LayoutApplyResult = {
  layout: HerdrPaneLayoutSnapshot
  tab_id?: string
  workspace_id?: string
}

export type LayoutSetSplitRatioParams = {
  pane_id?: string | null
  path: boolean[]
  ratio: number
  tab_id?: string | null
}

export type LayoutSetSplitRatioResult = {
  layout: HerdrPaneLayoutSnapshot
}

export type ServerLiveHandoffParams = {
  expected_protocol?: number | null
  expected_version?: string | null
  import_exe?: string | null
}

export type ServerLiveHandoffResult = {
  handed_off: boolean
}

export type HerdrPaneLayoutSnapshot = {
  workspace_id: string
  tab_id: string
  panes: HerdrPaneLayoutPane[]
  area?: HerdrPaneLayoutRect
  focused_pane_id?: string
  splits?: HerdrPaneLayoutSplit[]
  zoomed?: boolean
}

export type HerdrPaneLayoutRect = {
  x: number
  y: number
  width: number
  height: number
}

export type HerdrPaneLayoutPane = {
  pane_id: string
  rect: HerdrPaneLayoutRect
  focused?: boolean
}

export type HerdrPaneLayoutSplit = {
  id: string
  direction: 'right' | 'down'
  ratio: number
  rect: HerdrPaneLayoutRect
}

export type PaneReadParams = {
  pane_id: string
  format?: 'text' | 'ansi'
  lines?: number | null
  source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
  strip_ansi?: boolean
}

export type PaneReadResult = {
  pane_id: string
  workspace_id: string
  tab_id: string
  source: string
  format: string
  text: string
  revision: number
  truncated: boolean
}

/** Wire envelope for pane.read responses (paneRead returns this from transport). */
export type PaneReadWireResponse = {
  type: 'pane_read'
  read: PaneReadResult
}

export type PaneSendInputParams = {
  pane_id: string
  keys?: string[]
  text?: string
}

export type PaneResizeParams = {
  amount?: number | null
  direction: 'left' | 'right' | 'up' | 'down'
  pane_id?: string | null
}

export type PaneResizeResult = {
  changed: boolean
  pane_id: string
  focused_pane_id: string
  layout: HerdrPaneLayoutSnapshot
  reason?: string | null
}

export type SessionSnapshotResult = {
  snapshot: HerdrSessionSnapshotSummary
}

export type HerdrSessionSnapshotSummary = {
  layouts: HerdrPaneLayoutSnapshot[]
  [key: string]: unknown
}

export type HerdrSocketTransportOptions = {
  sessionName: string
  timeoutMs?: number
  socketPath?: string
  commandFor?: (args: string[]) => { file: string; args: string[]; env?: NodeJS.ProcessEnv }
  serverCommandFor?: (sessionName: string) => {
    file: string
    args: string[]
    env?: NodeJS.ProcessEnv
  }
  reconnection?: {
    enabled: boolean
    initialDelayMs: number
    maxDelayMs: number
    maxAttempts: number
    factor: number
  }
}

export type HerdrSocketTransportState = {
  connected: boolean
  socketPath: string
  sessionName: string
}
