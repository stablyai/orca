import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import type { WebContents } from 'electron'
import { CdpClientResponseWriter } from './cdp-client-response-writer'
import { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'
import { CdpTargetDiscovery } from './cdp-target-discovery'
import { CdpDebuggerChannel } from './cdp-debugger-channel'
import { CdpPageNavigationCommands } from './cdp-page-navigation-commands'
import { CdpDomFocusReplay } from './cdp-dom-focus-replay'
import { CdpPageCaptureCommands } from './cdp-page-capture-commands'

export class CdpWsProxy {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private detachClientListeners: (() => void) | null = null
  private port = 0
  private readonly responder = new CdpClientResponseWriter(() => this.client)
  private readonly sessions = new CdpSyntheticSessionRegistry()
  private readonly discovery: CdpTargetDiscovery
  private readonly debuggerChannel: CdpDebuggerChannel
  private readonly navigation: CdpPageNavigationCommands
  private readonly domFocusReplay: CdpDomFocusReplay
  private readonly pageCapture: CdpPageCaptureCommands

  constructor(private readonly webContents: WebContents) {
    this.discovery = new CdpTargetDiscovery(
      webContents,
      this.responder,
      this.sessions,
      () => this.port
    )
    this.debuggerChannel = new CdpDebuggerChannel(
      webContents,
      this.responder,
      this.sessions,
      () => this.client,
      () => this.stop()
    )
    this.navigation = new CdpPageNavigationCommands(
      webContents,
      this.responder,
      this.sessions,
      this.debuggerChannel
    )
    this.domFocusReplay = new CdpDomFocusReplay(webContents, this.responder, this.debuggerChannel)
    this.pageCapture = new CdpPageCaptureCommands(webContents, this.responder)
  }

  async start(): Promise<string> {
    await this.debuggerChannel.attachDebugger()
    return new Promise<string>((resolve, reject) => {
      this.httpServer = createServer((req, res) => this.discovery.handleHttpRequest(req, res))
      this.wss = new WebSocketServer({ server: this.httpServer })
      const failStart = (error: Error): void => {
        this.httpServer?.removeListener('error', onListenError)
        this.wss?.close()
        this.wss = null
        this.httpServer?.close()
        this.httpServer = null
        // Why: a bind failure happens after debugger attach; release it here
        // because callers cannot safely call stop() on a failed start.
        this.debuggerChannel.detachDebugger()
        reject(error)
      }
      const onListenError = (error: Error): void => {
        failStart(error)
      }
      this.wss.on('connection', (ws) => {
        this.closeClient()
        this.client = ws
        const onMessage = (data: WebSocket.RawData): void => {
          this.handleClientMessage(ws, data.toString())
        }
        const onClose = (): void => {
          detach()
          if (this.client === ws) {
            this.clearClientState()
            this.client = null
          }
        }
        const detach = (): void => {
          ws.off('message', onMessage)
          ws.off('close', onClose)
          if (this.detachClientListeners === detach) {
            this.detachClientListeners = null
          }
        }
        this.detachClientListeners = detach
        ws.on('message', onMessage)
        ws.on('close', onClose)
      })
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.httpServer?.removeListener('error', onListenError)
        const addr = this.httpServer!.address()
        if (typeof addr === 'object' && addr) {
          this.port = addr.port
          resolve(`ws://127.0.0.1:${this.port}`)
        } else {
          failStart(new Error('Failed to bind proxy server'))
        }
      })
      this.httpServer.once('error', onListenError)
    })
  }

  async stop(): Promise<void> {
    this.debuggerChannel.detachDebugger()
    this.closeClient()
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  getPort(): number {
    return this.port
  }

  private closeClient(): void {
    const client = this.client
    this.detachClientListeners?.()
    this.detachClientListeners = null
    this.client = null
    this.clearClientState()
    if (client) {
      this.responder.forgetClient(client)
    }
    client?.close()
  }

  private clearClientState(): void {
    // Why: session and focus state belongs to one websocket and must not cross client replacement.
    this.domFocusReplay.clear()
    this.pageCapture.clear()
    this.sessions.clear()
  }

  private handleClientMessage(client: WebSocket, raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id == null || !msg.method) {
      return
    }
    const clientId = msg.id
    this.responder.recordRequestSessionId(client, clientId, msg)

    if (this.discovery.handleCommand(client, clientId, msg)) {
      return
    }
    const effectiveSessionId = this.sessions.resolveDebuggerSessionId(msg.sessionId)
    this.domFocusReplay.invalidateForMethod(msg.method, effectiveSessionId)
    if (msg.method === 'Page.bringToFront') {
      if (!this.webContents.isDestroyed()) {
        this.webContents.focus()
      }
      this.responder.sendResult(clientId, {}, client)
      return
    }
    if (msg.method === 'DOM.focus') {
      this.domFocusReplay.forwardDomFocus(client, clientId, msg.params ?? {}, effectiveSessionId)
      return
    }
    // Why: Page.captureScreenshot via debugger.sendCommand hangs on Electron webview guests.
    if (msg.method === 'Page.captureScreenshot') {
      this.pageCapture.handleScreenshot(client, clientId, msg.params)
      return
    }
    // Why: CDP Page.printToPDF is not available for Electron webview guests.
    // Electron's native printToPDF path is the reliable equivalent.
    if (msg.method === 'Page.printToPDF') {
      void this.pageCapture.handlePrintToPdf(client, clientId, msg.params ?? {})
      return
    }
    if (msg.method === 'IO.read') {
      const params = msg.params ?? {}
      if (this.pageCapture.ownsHandle(params)) {
        this.pageCapture.handleStreamRead(client, clientId, params)
        return
      }
      this.debuggerChannel.forwardCommand(client, clientId, msg.method, params, msg.sessionId)
      return
    }
    if (msg.method === 'IO.close') {
      const params = msg.params ?? {}
      if (this.pageCapture.ownsHandle(params)) {
        this.pageCapture.handleStreamClose(client, clientId, params)
        return
      }
      this.debuggerChannel.forwardCommand(client, clientId, msg.method, params, msg.sessionId)
      return
    }
    // Why: Input.insertText can still require native focus in Electron webviews.
    // Do not auto-focus generic Runtime.evaluate/callFunctionOn traffic: wait
    // polling and read-only JS probes use those methods heavily, and focusing on
    // every eval steals the user's foreground window while background automation
    // is running.
    if (msg.method === 'Input.insertText' && !this.webContents.isDestroyed()) {
      this.webContents.focus()
      void this.domFocusReplay.forwardInsertText(
        client,
        clientId,
        msg.params ?? {},
        effectiveSessionId
      )
      return
    }
    // Why: agent-browser waits for network idle to detect navigation completion.
    // Electron webview CDP subscriptions silently lapse after cross-process swaps.
    // Page.reload needs the same priming: forwarding it unprimed closed the tab (#7031).
    if (msg.method === 'Page.navigate' && !this.webContents.isDestroyed()) {
      void this.navigation.navigateWithLifecycle(client, clientId, msg.params ?? {}, msg.sessionId)
      return
    }
    // Why: CDP Page.reload can destroy Electron webview targets during process swaps.
    // Use the same direct webContents reload path as Orca's own browser.reload.
    if (msg.method === 'Page.reload' && !this.webContents.isDestroyed()) {
      void this.navigation.reloadWithLifecycle(client, clientId, msg.params ?? {}, msg.sessionId)
      return
    }
    this.debuggerChannel.forwardCommand(
      client,
      clientId,
      msg.method,
      msg.params ?? {},
      msg.sessionId
    )
  }
}
