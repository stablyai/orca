export const HERDR_SCHEMA_VERSION = 1

export type HerdrApiSchema = {
  protocol: number
  schema_version: number
  schemas: Record<string, unknown>
}

export type HerdrWorkspace = {
  workspace_id: string
  label: string
  tokens?: Record<string, string>
  worktree?: { checkout_path: string }
}

export type HerdrTab = {
  tab_id: string
  workspace_id: string
  label: string
}

export type HerdrPane = {
  pane_id: string
  tab_id: string
  workspace_id: string
  cwd?: string
  foreground_cwd?: string
  label?: string
  title?: string
  terminal_title?: string
  terminal_title_stripped?: string
  agent?: string | null
  agent_status?: HerdrAgentStatus
  tokens?: Record<string, string>
  revision?: number
  focused?: boolean
}

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type HerdrAgentInfo = {
  agent: string | null
  agent_status: HerdrAgentStatus
  agent_session?: HerdrAgentSessionInfo | null
  cwd?: string | null
  display_agent?: string | null
  focused?: boolean
  foreground_cwd?: string | null
  interactive_ready?: boolean
  launch_pending?: boolean
  name?: string | null
  pane_id: string
  revision?: number
  state_labels?: Record<string, string>
  tab_id?: string
  terminal_id?: string
  terminal_title?: string | null
  terminal_title_stripped?: string | null
}

export type HerdrAgentSessionInfo = {
  source: string
  agent: string
  kind: string
  value: string
}

export type HerdrSessionSnapshot = {
  version: string
  protocol: number
  workspaces: HerdrWorkspace[]
  tabs: HerdrTab[]
  panes: HerdrPane[]
  layouts: HerdrPaneLayoutSnapshot[]
  agents: unknown[]
}

export type HerdrPaneLayoutRect = { x: number; y: number; width: number; height: number }

export type HerdrPaneLayoutPane = { pane_id: string; rect: HerdrPaneLayoutRect; focused?: boolean }

export type HerdrPaneLayoutSplit = {
  id: string
  direction: 'right' | 'down'
  ratio: number
  rect: HerdrPaneLayoutRect
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

export type HerdrResponse<T> =
  | { id: string; result: T }
  | { id: string; error: { code: string; message: string } }

export type HerdrTerminalFrame = {
  type: 'terminal.frame'
  seq: number
  encoding: 'ansi'
  width: number
  height: number
  full: boolean
  bytes: string
}

export type HerdrTerminalClosed = { type: 'terminal.closed'; reason: string }

export type HerdrTerminalController = {
  write(data: string): void
  resize(cols: number, rows: number): void
  release(): void
  onFrame(listener: (frame: HerdrTerminalFrame) => void): () => void
  onClosed(listener: (event: HerdrTerminalClosed) => void): () => void
}

export type HerdrTerminalControlOptions = { cols: number; rows: number; takeover?: boolean }

export type HerdrHostTransport = {
  ensureSession(sessionName: string): Promise<void>
  request<T>(sessionName: string, method: string, params: unknown): Promise<HerdrResponse<T>>
  controlTerminal?(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController
  // Optional event stream (socket transport); CLI/SSH transports omit it.
  onEvent?(listener: (event: HerdrTransportEvent) => void): () => void
  // Tear down persistent connections (socket event connection, timers).
  disconnect?(): Promise<void>
}

export type HerdrTransportEvent = {
  event: string
  data: { type: string; [key: string]: unknown }
}

export class HerdrRuntimeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrRuntimeError'
    this.code = code
  }
}

export function assertHerdrSchemaCompatible(schema: HerdrApiSchema): void {
  if (schema.schema_version !== HERDR_SCHEMA_VERSION) {
    throw new HerdrRuntimeError(
      'herdr_incompatible',
      `Orca requires Herdr API schema ${HERDR_SCHEMA_VERSION}; received ${schema.schema_version}`
    )
  }
  if (!Number.isInteger(schema.protocol) || schema.protocol < 1) {
    throw new HerdrRuntimeError('herdr_incompatible', 'Herdr API schema has an invalid protocol')
  }
  const missing = REQUIRED_HERDR_METHODS.filter(
    (method) => !schemaDeclaresRequestMethod(schema.schemas?.request, method)
  )
  if (missing.length > 0) {
    throw new HerdrRuntimeError(
      'herdr_incompatible',
      `Herdr is missing required stock API methods: ${missing.join(', ')}`
    )
  }
}

// Walk the request schema looking for a {"const": "<method>"} declaration so the
// required-method check does not depend on how the schema happens to serialize.
function schemaDeclaresRequestMethod(node: unknown, method: string): boolean {
  if (typeof node === 'object' && node !== null) {
    const candidate = node as Record<string, unknown>
    if (candidate.const === method) {
      return true
    }
    return Object.values(candidate).some((value) => schemaDeclaresRequestMethod(value, method))
  }
  return false
}

export function assertHerdrServerCompatible(schema: HerdrApiSchema, protocol: number): void {
  if (protocol !== schema.protocol) {
    throw new HerdrRuntimeError(
      'herdr_incompatible',
      `Herdr client protocol ${schema.protocol} does not match the running server protocol ${protocol}. Restart the Herdr session with the installed binary.`
    )
  }
}

export function unwrapHerdrResponse<T>(response: HerdrResponse<T>): T {
  if ('error' in response) {
    throw new HerdrRuntimeError(response.error.code, response.error.message)
  }
  return response.result
}

export const REQUIRED_HERDR_METHODS = [
  // Session
  'session.snapshot',

  // Workspace
  'workspace.create',
  'workspace.list',
  'workspace.get',
  'workspace.focus',
  'workspace.rename',
  'workspace.report_metadata',
  'workspace.close',
  'workspace.move',
  'workspace.move_block',

  // Worktree
  'worktree.open',
  'worktree.list',
  'worktree.create',
  'worktree.remove',

  // Tab
  'tab.create',
  'tab.list',
  'tab.get',
  'tab.focus',
  'tab.rename',
  'tab.move',
  'tab.close',

  // Pane
  'pane.split',
  'pane.get',
  'pane.focus',
  'pane.list',
  'pane.current',
  'pane.process_info',
  'pane.read',
  'pane.send_keys',
  'pane.send_text',
  'pane.wait_for_output',
  'pane.report_metadata',
  'pane.report_agent',
  'pane.report_agent_session',
  'pane.release_agent',
  'pane.close',
  'pane.rename',
  'pane.layout',
  'pane.neighbor',
  'pane.edges',
  'pane.zoom',
  'pane.swap',
  'pane.move',
  'pane.resize',

  // Agent
  'agent.list',
  'agent.get',
  'agent.wait',
  'agent.read',
  'agent.rename',
  'agent.focus',
  'agent.explain',
  'agent.start',
  'agent.prompt',
  'agent.send_keys',

  // Notification
  'notification.show',

  // Server
  'server.live_handoff',
  'server.stop',
  'server.reload_config',
  'server.agent_manifests',
  'server.reload_agent_manifests',

  // Events
  'events.subscribe',
  'events.wait',

  // Layout
  'layout.export',
  'layout.apply',
  'layout.set_split_ratio',

  // Pane socket-only
  'pane.focus_direction',
  'pane.send_input',
  'pane.clear_agent_authority',
  'pane.graphics.set',
  'pane.graphics.clear',
  'pane.graphics.info',

  // Agent socket-only
  'agent.view.set',
  'agent.view.clear',

  // Client
  'client.window_title.set',
  'client.window_title.clear',

  // Plugin
  'plugin.link',
  'plugin.list',
  'plugin.unlink',
  'plugin.enable',
  'plugin.disable',
  'plugin.action.list',
  'plugin.action.invoke',
  'plugin.log.list',
  'plugin.pane.open',
  'plugin.pane.focus',
  'plugin.pane.close',

  // Integration
  'integration.install',
  'integration.uninstall',

  // Popup
  'popup.close',

  // Ping
  'ping'
] as const

// Export all types that were previously in the results file for backward compatibility
export type {
  HerdrPaneZoomResult,
  HerdrPaneSwapResult,
  HerdrPaneMoveResult,
  HerdrPaneResizeResult,
  HerdrPaneFocusDirectionResult,
  HerdrNotificationShowResult,
  HerdrAgentListResult,
  HerdrAgentReadResult,
  HerdrAgentExplainResult,
  HerdrOutputMatchedResult,
  HerdrPaneNeighborResult,
  HerdrPaneEdgesResult,
  HerdrLayoutNode,
  HerdrLayoutExportResult,
  HerdrLayoutApplyResult,
  HerdrLayoutSetSplitRatioResult,
  HerdrEventEnvelope,
  HerdrEventsSubscribeResult,
  HerdrEventsWaitResult,
  HerdrWorktreeInfo,
  HerdrWorktreeListResult,
  HerdrServerLiveHandoffResult,
  HerdrPingResult
} from './herdr-runtime-contract-results'
