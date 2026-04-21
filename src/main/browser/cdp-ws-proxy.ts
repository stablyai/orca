import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { WebContents } from 'electron'
import { captureScreenshot } from './cdp-screenshot'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'

export class CdpWsProxy {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private port = 0
  private debuggerMessageHandler: ((...args: unknown[]) => void) | null = null
  private debuggerDetachHandler: ((...args: unknown[]) => void) | null = null
  private attached = false
  // Why: agent-browser filters events by sessionId from Target.attachToTarget.
  private clientSessionId: string | undefined = undefined

  constructor(private readonly webContents: WebContents) {}

  async start(): Promise<string> {
    await this.attachDebugger()
    return new Promise<string>((resolve, reject) => {
      this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))
      this.wss = new WebSocketServer({ server: this.httpServer })
      this.wss.on('connection', (ws) => {
        if (this.client) {
          this.client.close()
        }
        this.client = ws
        ws.on('message', (data) => this.handleClientMessage(ws, data.toString()))
        ws.on('close', () => {
          if (this.client === ws) {
            this.client = null
          }
        })
      })
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address()
        if (typeof addr === 'object' && addr) {
          this.port = addr.port
          resolve(`ws://127.0.0.1:${this.port}`)
        } else {
          reject(new Error('Failed to bind proxy server'))
        }
      })
      this.httpServer.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    this.detachDebugger()
    if (this.client) {
      this.client.close()
      this.client = null
    }
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

  private send(payload: unknown, client = this.client): void {
    if (client?.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload))
    }
  }

  private sendResult(clientId: number, result: unknown, client = this.client): void {
    this.send({ id: clientId, result }, client)
  }

  private sendError(clientId: number, message: string, client = this.client): void {
    this.send({ id: clientId, error: { code: -32000, message } }, client)
  }

  private buildTargetInfo(): Record<string, unknown> {
    const destroyed = this.webContents.isDestroyed()
    return {
      targetId: 'orca-proxy-target',
      type: 'page',
      title: destroyed ? '' : this.webContents.getTitle(),
      url: destroyed ? '' : this.webContents.getURL(),
      attached: true,
      canAccessOpener: false
    }
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''
    if (url === '/json/version' || url === '/json/version/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Why: agent-browser reads this endpoint to identify the browser. Returning
      // "Orca/CdpWsProxy" leaks that this is an embedded automation surface, which
      // could affect downstream detection heuristics.
      // Why: process.versions.chrome contains the exact Chromium version
      // bundled with Electron, producing a realistic version string.
      const chromeVersion = process.versions.chrome ?? '134.0.0.0'
      res.end(
        JSON.stringify({
          Browser: `Chrome/${chromeVersion}`,
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
        })
      )
      return
    }
    if (url === '/json' || url === '/json/' || url === '/json/list' || url === '/json/list/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            ...this.buildTargetInfo(),
            id: 'orca-proxy-target',
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
          }
        ])
      )
      return
    }
    res.writeHead(404)
    res.end()
  }

  private async attachDebugger(): Promise<void> {
    if (this.attached) {
      return
    }
    if (!this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.attach('1.3')
      } catch {
        throw new Error('Could not attach debugger. DevTools may already be open for this tab.')
      }
    }
    this.attached = true

    // Why: attaching the CDP debugger sets navigator.webdriver = true and
    // exposes other automation signals that Cloudflare Turnstile checks.
    // Inject before any page loads so challenges succeed.
    try {
      await this.webContents.debugger.sendCommand('Page.enable', {})
      await this.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: ANTI_DETECTION_SCRIPT
      })
    } catch {
      /* best-effort — page domain may not be ready yet */
    }

    this.debuggerMessageHandler = (_event: unknown, ...rest: unknown[]) => {
      const [method, params, sessionId] = rest as [
        string,
        Record<string, unknown>,
        string | undefined
      ]
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        return
      }
      // Why: Electron passes empty string (not undefined) for root-session events, but
      // agent-browser filters events by the sessionId from Target.attachToTarget.
      const msg: Record<string, unknown> = { method, params }
      msg.sessionId = sessionId || this.clientSessionId
      this.client.send(JSON.stringify(msg))
    }
    this.debuggerDetachHandler = () => {
      this.attached = false
      this.stop()
    }
    this.webContents.debugger.on('message', this.debuggerMessageHandler as never)
    this.webContents.debugger.on('detach', this.debuggerDetachHandler as never)
  }

  private detachDebugger(): void {
    if (this.debuggerMessageHandler) {
      this.webContents.debugger.removeListener('message', this.debuggerMessageHandler as never)
      this.debuggerMessageHandler = null
    }
    if (this.debuggerDetachHandler) {
      this.webContents.debugger.removeListener('detach', this.debuggerDetachHandler as never)
      this.debuggerDetachHandler = null
    }
    if (this.attached) {
      try {
        this.webContents.debugger.detach()
      } catch {
        /* already detached */
      }
      this.attached = false
    }
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

    if (msg.method === 'Target.getTargets') {
      this.sendResult(clientId, { targetInfos: [this.buildTargetInfo()] }, client)
      return
    }
    if (msg.method === 'Target.getTargetInfo') {
      this.sendResult(clientId, { targetInfo: this.buildTargetInfo() }, client)
      return
    }
    if (msg.method === 'Target.setDiscoverTargets' || msg.method === 'Target.detachFromTarget') {
      if (msg.method === 'Target.detachFromTarget') {
        this.clientSessionId = undefined
      }
      this.sendResult(clientId, {}, client)
      return
    }
    if (msg.method === 'Target.attachToTarget') {
      this.clientSessionId = 'orca-proxy-session'
      this.sendResult(clientId, { sessionId: this.clientSessionId }, client)
      return
    }
    if (msg.method === 'Browser.getVersion') {
      // Why: returning "Orca/Electron" identifies this as an embedded automation
      // surface to agent-browser. Use a generic Chrome product string instead.
      const chromeVersion = process.versions.chrome ?? '134.0.0.0'
      this.sendResult(
        clientId,
        {
          protocolVersion: '1.3',
          product: `Chrome/${chromeVersion}`,
          userAgent: '',
          jsVersion: ''
        },
        client
      )
      return
    }
    if (msg.method === 'Page.bringToFront') {
      if (!this.webContents.isDestroyed()) {
        this.webContents.focus()
      }
      this.sendResult(clientId, {}, client)
      return
    }
    // Why: Page.captureScreenshot via debugger.sendCommand hangs on Electron webview guests.
    if (msg.method === 'Page.captureScreenshot') {
      this.handleScreenshot(client, clientId, msg.params)
      return
    }
    // Why: Input.insertText can still require native focus in Electron webviews.
    // Do not auto-focus generic Runtime.evaluate/callFunctionOn traffic: wait
    // polling and read-only JS probes use those methods heavily, and focusing on
    // every eval steals the user's foreground window while background automation
    // is running.
    if (msg.method === 'Input.insertText' && !this.webContents.isDestroyed()) {
      this.webContents.focus()
    }
    // Why: agent-browser waits for network idle to detect navigation completion.
    // Electron webview CDP subscriptions silently lapse after cross-process swaps.
    if (msg.method === 'Page.navigate' && !this.webContents.isDestroyed()) {
      void this.navigateWithLifecycleEnsured(client, clientId, msg.params ?? {})
      return
    }
    this.forwardCommand(client, clientId, msg.method, msg.params ?? {}, msg.sessionId)
  }

  private forwardCommand(
    client: WebSocket,
    clientId: number,
    method: string,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): void {
    const sessionId =
      msgSessionId && msgSessionId !== this.clientSessionId ? msgSessionId : undefined
    this.webContents.debugger
      .sendCommand(method, params, sessionId)
      .then((result) => {
        this.sendResult(clientId, result, client)
      })
      .catch((err: Error) => {
        this.sendError(clientId, err.message, client)
      })
  }

  private async navigateWithLifecycleEnsured(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>
  ): Promise<void> {
    try {
      const dbg = this.webContents.debugger
      // Why: without Network.enable, agent-browser never sees network idle → goto times out.
      await dbg.sendCommand('Network.enable', {})
      await dbg.sendCommand('Page.enable', {})
      await dbg.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true })
    } catch {
      /* best-effort */
    }
    this.forwardCommand(client, clientId, 'Page.navigate', params)
  }

  private handleScreenshot(
    client: WebSocket,
    clientId: number,
    params?: Record<string, unknown>
  ): void {
    captureScreenshot(
      this.webContents,
      params,
      (result) => this.sendResult(clientId, result, client),
      (message) => this.sendError(clientId, message, client)
    )
  }
}
