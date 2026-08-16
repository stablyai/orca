import crypto from 'node:crypto'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalController,
  HerdrTerminalControlOptions
} from './herdr-runtime-contract'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import { HerdrSocketConnection, type HerdrSocketConnectionOptions } from './herdr-socket-connection'
import { HerdrSocketEventConnection } from './herdr-socket-events'
import { createStockHerdrTerminalController } from './herdr-terminal-observe'
import type {
  EventMatch,
  HerdrSocketEvent,
  LayoutApplyParams,
  LayoutApplyResult,
  LayoutExportParams,
  LayoutExportResult,
  LayoutSetSplitRatioParams,
  LayoutSetSplitRatioResult,
  PaneReadParams,
  PaneReadWireResponse,
  PaneResizeParams,
  PaneResizeResult,
  ServerLiveHandoffParams,
  ServerLiveHandoffResult,
  Subscription
} from './herdr-socket-types'
import { HerdrSocketSessionManager } from './herdr-socket-session'

export class HerdrSocketTransport implements HerdrHostTransport {
  private readonly options: HerdrSocketConnectionOptions
  private readonly connectionsBySession = new Map<string, HerdrSocketConnection>()
  private readonly eventConnectionsBySession = new Map<string, HerdrSocketEventConnection>()
  private readonly eventListeners = new Set<(event: HerdrSocketEvent) => void>()
  private readonly sessionManager: HerdrSocketSessionManager

  constructor(options: HerdrSocketConnectionOptions, sessionManager?: HerdrSocketSessionManager) {
    this.options = options
    this.sessionManager = sessionManager ?? new HerdrSocketSessionManager(options)
  }

  async ensureSession(sessionName: string): Promise<void> {
    await this.sessionManager.ensureSession(sessionName)
    let connection = this.connectionsBySession.get(sessionName)
    if (!connection) {
      connection = new HerdrSocketConnection({ ...this.options, sessionName })
      this.connectionsBySession.set(sessionName, connection)
      await connection.connect()
      await this.assertServerProtocolMatches(connection)
    }
    this.ensureEventSubscription(sessionName)
  }

  private async assertServerProtocolMatches(connection: HerdrSocketConnection): Promise<void> {
    const expectedProtocol = await this.sessionManager.schemaProtocol()
    const snapshot = await connection.request<{ snapshot: { protocol: number } }>(
      'session.snapshot',
      {}
    )
    if (expectedProtocol !== snapshot.snapshot.protocol) {
      throw new Error(
        `Herdr client protocol ${expectedProtocol} does not match the running server protocol ${snapshot.snapshot.protocol}. Restart the Herdr session with the installed binary.`
      )
    }
  }

  private connectionFor(sessionName: string): HerdrSocketConnection {
    const connection = this.connectionsBySession.get(sessionName)
    if (!connection) {
      throw new Error(`Herdr socket transport not initialized for session ${sessionName}`)
    }
    return connection
  }

  private async raw<T>(sessionName: string, method: string, params: unknown): Promise<T> {
    return await this.connectionFor(sessionName).request<T>(method, params)
  }

  // Socket-only helpers without a session argument route to the session this
  // transport was created for (the shared default session).
  private async sockRaw<T>(method: string, params: unknown): Promise<T> {
    return await this.raw(this.options.sessionName, method, params)
  }

  async request<T>(
    sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    try {
      const result = await this.raw<T>(sessionName, method, params)
      return { id: crypto.randomUUID(), result }
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        error: {
          code: error instanceof HerdrRuntimeError ? error.code : 'herdr_request_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  controlTerminal(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    return createStockHerdrTerminalController(sessionName, target, options, {
      commandFor: this.options.commandFor,
      request: (method, params) => this.raw(sessionName, method, params),
      onEvent: (listener) => this.onEvent(listener)
    })
  }

  onEvent(listener: (event: HerdrSocketEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private ensureEventSubscription(sessionName: string): void {
    if (this.eventConnectionsBySession.has(sessionName)) {
      return
    }
    const connection = new HerdrSocketEventConnection({
      ...this.options,
      sessionName
    })
    this.eventConnectionsBySession.set(sessionName, connection)
    connection.onEvent((event) => {
      for (const listener of this.eventListeners) {
        listener(event)
      }
    })
    void connection.connect().catch((error) => {
      console.error(
        '[herdr] Event connection failed:',
        error instanceof Error ? error.message : error
      )
    })
  }

  async isConnected(): Promise<boolean> {
    return this.connectionsBySession.size > 0
  }

  async disconnect(): Promise<void> {
    for (const connection of this.eventConnectionsBySession.values()) {
      await connection.disconnect()
    }
    this.eventConnectionsBySession.clear()
    this.eventListeners.clear()
    this.connectionsBySession.clear()
  }

  // Events
  async eventsSubscribe(subscriptions: Subscription[]): Promise<void> {
    this.ensureEventSubscription(this.options.sessionName)
    const connection = this.eventConnectionsBySession.get(this.options.sessionName)
    if (connection) {
      await connection.connect()
    }
    void subscriptions
  }

  async eventsWait(match: EventMatch, timeoutMs?: number): Promise<HerdrSocketEvent> {
    return await this.sockRaw<HerdrSocketEvent>('events.wait', {
      match_event: match,
      timeout_ms: timeoutMs
    })
  }

  // Layout
  async layoutExport(params: LayoutExportParams): Promise<LayoutExportResult> {
    return await this.sockRaw('layout.export', params)
  }
  async layoutApply(params: LayoutApplyParams): Promise<LayoutApplyResult> {
    return await this.sockRaw('layout.apply', params)
  }
  async layoutSetSplitRatio(params: LayoutSetSplitRatioParams): Promise<LayoutSetSplitRatioResult> {
    return await this.sockRaw('layout.set_split_ratio', params)
  }

  // Server
  async serverLiveHandoff(params: ServerLiveHandoffParams): Promise<ServerLiveHandoffResult> {
    return await this.sockRaw('server.live_handoff', params)
  }
  async serverStop(): Promise<unknown> {
    return await this.sockRaw('server.stop', {})
  }
  async serverReloadConfig(): Promise<unknown> {
    return await this.sockRaw('server.reload_config', {})
  }
  async serverAgentManifests(): Promise<unknown> {
    return await this.sockRaw('server.agent_manifests', {})
  }
  async serverReloadAgentManifests(): Promise<unknown> {
    return await this.sockRaw('server.reload_agent_manifests', {})
  }

  // Ping
  async ping(): Promise<unknown> {
    return await this.sockRaw('ping', {})
  }

  // Pane socket-only
  async paneRead(params: PaneReadParams): Promise<PaneReadWireResponse> {
    return await this.sockRaw('pane.read', params)
  }
  async paneResize(params: PaneResizeParams): Promise<PaneResizeResult> {
    return await this.sockRaw('pane.resize', params)
  }
  async paneFocusDirection(params: {
    direction: 'left' | 'right' | 'up' | 'down'
    pane_id?: string | null
  }): Promise<unknown> {
    return await this.sockRaw('pane.focus_direction', params)
  }
  async paneFocus(params: { pane_id: string }): Promise<unknown> {
    return await this.sockRaw('pane.focus', params)
  }
  async paneSendText(params: { pane_id: string; text: string }): Promise<unknown> {
    return await this.sockRaw('pane.send_text', params)
  }
  async paneClearAgentAuthority(params: {
    pane_id: string
    seq?: number | null
    source?: string | null
  }): Promise<unknown> {
    return await this.sockRaw('pane.clear_agent_authority', params)
  }
  async paneGraphicsSet(params: unknown): Promise<unknown> {
    return await this.sockRaw('pane.graphics.set', params)
  }
  async paneGraphicsClear(params: unknown): Promise<unknown> {
    return await this.sockRaw('pane.graphics.clear', params)
  }
  async paneGraphicsInfo(params: unknown): Promise<unknown> {
    return await this.sockRaw('pane.graphics.info', params)
  }

  // Agent view socket-only
  async agentViewSet(params: {
    source: string
    label?: string | null
    filter?: unknown
    sort?: unknown[]
  }): Promise<unknown> {
    return await this.sockRaw('agent.view.set', params)
  }
  async agentViewClear(params: { source?: string | null }): Promise<unknown> {
    return await this.sockRaw('agent.view.clear', params)
  }

  // Workspace
  async workspaceList(): Promise<unknown> {
    return await this.sockRaw('workspace.list', {})
  }
  async workspaceMove(params: { workspace_id: string; insert_index: number }): Promise<unknown> {
    return await this.sockRaw('workspace.move', params)
  }
  async workspaceMoveBlock(params: {
    workspace_ids: string[]
    before_workspace_id?: string | null
  }): Promise<unknown> {
    return await this.sockRaw('workspace.move_block', params)
  }

  // Tab socket-only
  async tabMove(params: { tab_id: string; insert_index: number }): Promise<unknown> {
    return await this.sockRaw('tab.move', params)
  }

  // Client socket-only
  async clientWindowTitleSet(params: { title: string }): Promise<unknown> {
    return await this.sockRaw('client.window_title.set', params)
  }
  async clientWindowTitleClear(): Promise<unknown> {
    return await this.sockRaw('client.window_title.clear', {})
  }

  // Plugin
  async pluginLink(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.link', params)
  }
  async pluginList(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.list', params)
  }
  async pluginUnlink(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.unlink', params)
  }
  async pluginEnable(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.enable', params)
  }
  async pluginDisable(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.disable', params)
  }
  async pluginActionList(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.action.list', params)
  }
  async pluginActionInvoke(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.action.invoke', params)
  }
  async pluginLogList(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.log.list', params)
  }
  async pluginPaneOpen(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.pane.open', params)
  }
  async pluginPaneFocus(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.pane.focus', params)
  }
  async pluginPaneClose(params: unknown): Promise<unknown> {
    return await this.sockRaw('plugin.pane.close', params)
  }

  // Integration
  async integrationInstall(params: unknown): Promise<unknown> {
    return await this.sockRaw('integration.install', params)
  }
  async integrationUninstall(params: unknown): Promise<unknown> {
    return await this.sockRaw('integration.uninstall', params)
  }

  // Popup
  async popupClose(params: unknown): Promise<unknown> {
    return await this.sockRaw('popup.close', params)
  }
}
