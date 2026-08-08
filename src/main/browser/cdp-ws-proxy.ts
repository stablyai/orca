/* eslint-disable max-lines -- Why: this proxy owns HTTP discovery, websocket client lifecycle, and CDP debugger forwarding together. */
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { ipcMain, type WebContents } from 'electron'
import { captureScreenshot } from './cdp-screenshot'
import { buildPrintToPdfOptions, CdpPdfStreamStore } from './cdp-print-to-pdf'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

const LIFECYCLE_PRIMING_TIMEOUT_MS = 1_000
// Why: the renderer answers within a frame; this only bounds the wait for a host
// that never will, so the input falls through instead of hanging on it.
const FOCUS_ACK_TIMEOUT_MS = 64

// Why: borrows are matched by id across every proxy instance, so the counter cannot
// live on one of them.
let nextFocusBorrowId = 0

export class CdpWsProxy {
  // Why: holds each session's last DOM.focus params to replay right before the next
  // Input.insertText, countering the native webContents.focus() that would blur the target.
  private pendingDomFocusBySession = new Map<
    string | undefined,
    Promise<Record<string, unknown> | undefined>
  >()
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private readonly responseSessionIdsByClient = new WeakMap<WebSocket, Map<number, string>>()
  private detachClientListeners: (() => void) | null = null
  private port = 0
  private debuggerMessageHandler: ((...args: unknown[]) => void) | null = null
  private debuggerDetachHandler: ((...args: unknown[]) => void) | null = null
  private debuggerLease: ElectronDebuggerLease | null = null
  private attached = false
  // Why: agent-browser filters events by sessionId from Target.attachToTarget.
  private clientSessionId: string | undefined = undefined
  private readonly clientSessionIds = new Set<string>()
  private readonly clientBrowserSessionIds = new Set<string>()
  private nextClientSessionOrdinal = 0
  private nextClientBrowserSessionOrdinal = 0
  private readonly pdfStreams = new CdpPdfStreamStore()
  private readonly pendingFocusBorrows = new Map<number, (focused: boolean) => void>()
  private focusReplyHandler: ((...args: unknown[]) => void) | null = null

  constructor(private readonly webContents: WebContents) {}

  async start(): Promise<string> {
    await this.attachDebugger()
    return new Promise<string>((resolve, reject) => {
      this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))
      this.wss = new WebSocketServer({ server: this.httpServer })
      const failStart = (error: Error): void => {
        this.httpServer?.removeListener('error', onListenError)
        this.wss?.close()
        this.wss = null
        this.httpServer?.close()
        this.httpServer = null
        // Why: a bind failure happens after debugger attach; release it here
        // because callers cannot safely call stop() on a failed start.
        this.detachDebugger()
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
    this.detachDebugger()
    this.closeClient()
    if (this.focusReplyHandler) {
      ipcMain.removeListener('browser:agentInputFocusReply', this.focusReplyHandler)
      this.focusReplyHandler = null
    }
    // Why: any borrow still in flight is settled by its own timeout, so dropping the
    // entries here only stops late replies from resolving a stopped proxy.
    this.pendingFocusBorrows.clear()
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
      this.responseSessionIdsByClient.delete(client)
    }
    client?.close()
  }

  private clearClientState(): void {
    // Why: session and focus state belongs to one websocket and must not cross client replacement.
    this.pendingDomFocusBySession.clear()
    this.pdfStreams.clear()
    this.clientSessionId = undefined
    this.clientSessionIds.clear()
    this.clientBrowserSessionIds.clear()
    this.nextClientSessionOrdinal = 0
    this.nextClientBrowserSessionOrdinal = 0
  }

  private send(payload: unknown, client = this.client): void {
    const responsePayload = client ? this.addResponseSessionId(payload, client) : payload
    if (client?.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(responsePayload))
    }
  }

  private addResponseSessionId(payload: unknown, client: WebSocket): unknown {
    if (typeof payload !== 'object' || payload === null) {
      return payload
    }
    const clientId = (payload as { id?: unknown }).id
    if (typeof clientId !== 'number') {
      return payload
    }
    const responseSessionIds = this.responseSessionIdsByClient.get(client)
    const sessionId = responseSessionIds?.get(clientId)
    responseSessionIds?.delete(clientId)
    return sessionId ? { ...payload, sessionId } : payload
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
    try {
      this.debuggerLease = acquireElectronDebugger(this.webContents)
    } catch {
      throw new Error('Could not attach debugger. DevTools may already be open for this tab.')
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
      const lease = this.debuggerLease
      this.debuggerLease = null
      lease?.release()
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
    const lease = this.debuggerLease
    this.debuggerLease = null
    lease?.release()
    this.attached = false
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
    const responseSessionIds = this.responseSessionIdsByClient.get(client) ?? new Map()
    if (msg.sessionId) {
      responseSessionIds.set(clientId, msg.sessionId)
    } else {
      responseSessionIds.delete(clientId)
    }
    this.responseSessionIdsByClient.set(client, responseSessionIds)

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
        const detachedSessionId = msg.params?.sessionId
        if (typeof detachedSessionId === 'string') {
          this.clientSessionIds.delete(detachedSessionId)
          this.clientBrowserSessionIds.delete(detachedSessionId)
          if (detachedSessionId === this.clientSessionId) {
            this.clientSessionId = this.clientSessionIds.values().next().value
          }
        }
      }
      this.sendResult(clientId, {}, client)
      return
    }
    if (msg.method === 'Target.attachToBrowserTarget') {
      // Why: Playwright needs a distinct browser session before it attaches to the selected page.
      const sessionId = this.nextSyntheticBrowserSessionId()
      this.clientBrowserSessionIds.add(sessionId)
      this.sendResult(clientId, { sessionId }, client)
      return
    }
    if (msg.method === 'Target.attachToTarget') {
      const sessionId = this.nextSyntheticPageSessionId()
      this.clientSessionIds.add(sessionId)
      this.clientSessionId ??= sessionId
      this.sendResult(clientId, { sessionId }, client)
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
    const effectiveSessionId = this.resolveDebuggerSessionId(msg.sessionId)
    // Why: a stored focus is only valid for the immediately following Input.insertText;
    // any other command may have moved DOM focus, so invalidate the replay in one place.
    if (msg.method !== 'DOM.focus' && msg.method !== 'Input.insertText') {
      this.pendingDomFocusBySession.delete(effectiveSessionId)
    }
    if (msg.method === 'Page.bringToFront') {
      if (!this.webContents.isDestroyed()) {
        this.webContents.focus()
      }
      this.sendResult(clientId, {}, client)
      return
    }
    if (msg.method === 'DOM.focus') {
      this.forwardDomFocus(client, clientId, msg.params ?? {}, effectiveSessionId)
      return
    }
    // Why: Page.captureScreenshot via debugger.sendCommand hangs on Electron webview guests.
    if (msg.method === 'Page.captureScreenshot') {
      this.handleScreenshot(client, clientId, msg.params)
      return
    }
    // Why: CDP Page.printToPDF is not available for Electron webview guests.
    // Electron's native printToPDF path is the reliable equivalent.
    if (msg.method === 'Page.printToPDF') {
      void this.handlePrintToPdf(client, clientId, msg.params ?? {})
      return
    }
    if (msg.method === 'IO.read') {
      const params = msg.params ?? {}
      if (this.pdfStreams.ownsHandle(params)) {
        this.handleStreamRead(client, clientId, params)
        return
      }
      this.forwardCommand(client, clientId, msg.method, params, msg.sessionId)
      return
    }
    if (msg.method === 'IO.close') {
      const params = msg.params ?? {}
      if (this.pdfStreams.ownsHandle(params)) {
        this.handleStreamClose(client, clientId, params)
        return
      }
      this.forwardCommand(client, clientId, msg.method, params, msg.sessionId)
      return
    }
    // Why: Input.insertText can still require native focus in Electron webviews.
    // Do not auto-focus generic Runtime.evaluate/callFunctionOn traffic: wait
    // polling and read-only JS probes use those methods heavily, and focusing on
    // every eval steals the user's foreground window while background automation
    // is running.
    if (msg.method === 'Input.insertText' && !this.webContents.isDestroyed()) {
      void this.withBorrowedFocus(
        () => this.forwardInsertText(client, clientId, msg.params ?? {}, effectiveSessionId),
        true
      ).catch((err: Error) => {
        // Why: forwardInsertText answers its own failures, so only a refused focus
        // borrow reaches here — and it must still answer, or the client hangs.
        this.sendError(clientId, err.message, client)
      })
      return
    }
    // Why: key events need the same native focus as insertText, and mouse presses
    // take it on their own. Both went out unguarded before, so agent input either
    // leaked into the user's window or left focus parked on the browser pane.
    if (msg.method === 'Input.dispatchKeyEvent' && !this.webContents.isDestroyed()) {
      this.forwardInputCommand(client, clientId, msg.method, msg.params ?? {}, msg.sessionId, true)
      return
    }
    if (msg.method === 'Input.dispatchMouseEvent' && !this.webContents.isDestroyed()) {
      // Why: only the press moves focus onto the guest, so only it needs the
      // borrow/return pair. Releases, moves and wheels never take focus — borrowing
      // for them would add a frame of latency to every click and, worse, create the
      // very focus hop this guards against.
      const mouseEventType = (msg.params as { type?: unknown } | undefined)?.type
      const takesFocus = mouseEventType === 'mousePressed'
      this.forwardInputCommand(
        client,
        clientId,
        msg.method,
        msg.params ?? {},
        msg.sessionId,
        takesFocus
      )
      return
    }
    // Why: agent-browser waits for network idle to detect navigation completion.
    // Electron webview CDP subscriptions silently lapse after cross-process swaps.
    // Page.reload needs the same priming: forwarding it unprimed closed the tab (#7031).
    if (msg.method === 'Page.navigate' && !this.webContents.isDestroyed()) {
      void this.navigateWithLifecycle(client, clientId, msg.params ?? {}, msg.sessionId)
      return
    }
    // Why: CDP Page.reload can destroy Electron webview targets during process swaps.
    // Use the same direct webContents reload path as Orca's own browser.reload.
    if (msg.method === 'Page.reload' && !this.webContents.isDestroyed()) {
      void this.reloadWithLifecycle(client, clientId, msg.params ?? {}, msg.sessionId)
      return
    }
    this.forwardCommand(client, clientId, msg.method, msg.params ?? {}, msg.sessionId)
  }

  private resolveDebuggerSessionId(msgSessionId?: string): string | undefined {
    const syntheticSession =
      (msgSessionId && this.clientSessionIds.has(msgSessionId)) ||
      (msgSessionId && this.clientBrowserSessionIds.has(msgSessionId))
    return msgSessionId && !syntheticSession ? msgSessionId : undefined
  }

  private nextSyntheticPageSessionId(): string {
    this.nextClientSessionOrdinal += 1
    return this.nextClientSessionOrdinal === 1
      ? 'orca-proxy-session'
      : `orca-proxy-session-${this.nextClientSessionOrdinal}`
  }

  private nextSyntheticBrowserSessionId(): string {
    this.nextClientBrowserSessionOrdinal += 1
    return this.nextClientBrowserSessionOrdinal === 1
      ? 'orca-proxy-browser-session'
      : `orca-proxy-browser-session-${this.nextClientBrowserSessionOrdinal}`
  }

  private isActiveClient(client: WebSocket): boolean {
    return this.client === client && client.readyState === WebSocket.OPEN
  }

  // Why: CDP input only reaches an Electron <webview> guest while its host window
  // holds native keyboard focus. Without it Chromium routes the event to whichever
  // window actually has focus — the user's — so agent keystrokes land in whatever
  // they are typing into while the CDP call still reports success. Borrow focus for
  // the duration of the command and hand it straight back, so background automation
  // neither loses its input nor parks itself in the user's foreground.
  // Why: the guest lives inside a renderer <webview>, so only the renderer can move
  // DOM focus onto it — webContents.focus() from main does nothing here. Tell the
  // host renderer to lend focus to the guest for the input, then take it back.
  private notifyAgentInput(phase: 'begin' | 'end', borrowId: number): boolean {
    try {
      const host = (this.webContents as unknown as { hostWebContents?: WebContents })
        .hostWebContents
      if (host && !host.isDestroyed()) {
        // Why: the host renders every open tab's pane, so name the guest. Without it
        // a background tab would grab focus on another tab's agent input.
        host.send('ui:browserAgentInput', { phase, guestId: this.webContents.id, borrowId })
        return true
      }
    } catch {
      // Why: offscreen/headless guests have no host renderer to lend focus. The
      // handoff is a courtesy to the user's window, never a reason to drop input.
    }
    return false
  }

  private async withBorrowedFocus<T>(run: () => Promise<T>, acquire: boolean): Promise<T> {
    // Why: events that never touch focus (mouse moves, wheels) must not announce a
    // borrow — the renderer would have nothing to give back and the pairing would
    // only add a needless focus hop.
    if (!acquire) {
      return await run()
    }
    nextFocusBorrowId += 1
    const borrowId = nextFocusBorrowId
    // Why: register before announcing, so a reply that lands on the same tick still
    // finds its borrow waiting.
    const granted = this.awaitFocusGrant(borrowId)
    if (!this.notifyAgentInput('begin', borrowId)) {
      this.pendingFocusBorrows.get(borrowId)?.(true)
      return await run()
    }
    try {
      // Why: the guest can fail to take focus while staying perfectly alive — a hidden
      // or detached pane still answers CDP. Forwarding then puts the keystroke in
      // whatever the user is typing into, which is the leak this whole path exists to
      // close, so fail the command instead and let the agent see it.
      if (!(await granted)) {
        throw new Error('Browser tab could not take keyboard focus for agent input')
      }
      return await run()
    } finally {
      this.notifyAgentInput('end', borrowId)
    }
  }

  private awaitFocusGrant(borrowId: number): Promise<boolean> {
    this.ensureFocusReplyListener()
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (focused: boolean): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        this.pendingFocusBorrows.delete(borrowId)
        resolve(focused)
      }
      // Why: no pane hosts this guest yet, so nobody will answer. Treat silence as the
      // pre-handoff behaviour — forward the input — rather than dropping it.
      timer = setTimeout(() => settle(true), FOCUS_ACK_TIMEOUT_MS)
      this.pendingFocusBorrows.set(borrowId, settle)
    })
  }

  private ensureFocusReplyListener(): void {
    if (this.focusReplyHandler) {
      return
    }
    this.focusReplyHandler = (...args: unknown[]): void => {
      const reply = args[1] as { borrowId?: number; focused?: boolean } | undefined
      if (typeof reply?.borrowId !== 'number') {
        return
      }
      this.pendingFocusBorrows.get(reply.borrowId)?.(reply.focused === true)
    }
    ipcMain.on('browser:agentInputFocusReply', this.focusReplyHandler)
  }

  // Why: input commands must return focus once the event has landed, so they cannot
  // reuse forwardCommand's fire-and-forget dispatch.
  private forwardInputCommand(
    client: WebSocket,
    clientId: number,
    method: string,
    params: Record<string, unknown>,
    msgSessionId: string | undefined,
    acquireFocus: boolean
  ): void {
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    const sessionId = this.resolveDebuggerSessionId(msgSessionId)
    void this.withBorrowedFocus(
      () => this.sendDebuggerCommand(method, params, sessionId),
      acquireFocus
    )
      .then((result) => {
        this.sendResult(clientId, result, client)
      })
      .catch((err: Error) => {
        this.sendError(clientId, err.message, client)
      })
  }

  private sendDebuggerCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const command = sessionId
      ? this.webContents.debugger.sendCommand(method, params, sessionId)
      : this.webContents.debugger.sendCommand(method, params)
    return Promise.resolve(command)
  }

  private forwardCommand(
    client: WebSocket,
    clientId: number,
    method: string,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): void {
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    const sessionId = this.resolveDebuggerSessionId(msgSessionId)
    try {
      this.sendDebuggerCommand(method, params, sessionId)
        .then((result) => {
          this.sendResult(clientId, result, client)
        })
        .catch((err: Error) => {
          this.sendError(clientId, err.message, client)
        })
    } catch (err) {
      this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private async navigateWithLifecycle(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): Promise<void> {
    await this.primePageLifecycle(this.resolveDebuggerSessionId(msgSessionId))
    if (!this.isActiveClient(client)) {
      return
    }
    this.forwardCommand(client, clientId, 'Page.navigate', params, msgSessionId)
  }

  private async reloadWithLifecycle(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): Promise<void> {
    const sessionId = this.resolveDebuggerSessionId(msgSessionId)
    const unsupportedParam = sessionId ? null : this.getUnsupportedRootReloadParam(params)
    if (unsupportedParam) {
      this.sendError(
        clientId,
        `Page.reload parameter "${unsupportedParam}" is not supported for Orca tab reloads`,
        client
      )
      return
    }
    await this.primePageLifecycle(sessionId)
    if (!this.isActiveClient(client)) {
      return
    }
    if (sessionId) {
      this.forwardCommand(client, clientId, 'Page.reload', params, msgSessionId)
      return
    }
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      if (params.ignoreCache === true) {
        this.webContents.reloadIgnoringCache()
      } else {
        this.webContents.reload()
      }
      this.sendResult(clientId, {}, client)
    } catch (err) {
      this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private getUnsupportedRootReloadParam(params: Record<string, unknown>): string | null {
    return Object.keys(params).find((key) => key !== 'ignoreCache') ?? null
  }

  private async primePageLifecycle(sessionId?: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const priming = (async (): Promise<void> => {
      // Why: without Network.enable, agent-browser never sees network idle → goto times out.
      await this.sendDebuggerCommand('Network.enable', {}, sessionId)
      await this.sendDebuggerCommand('Page.enable', {}, sessionId)
      await this.sendDebuggerCommand('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
    })().catch(() => {})

    try {
      await Promise.race([
        priming,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, LIFECYCLE_PRIMING_TIMEOUT_MS)
          timeout.unref?.()
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  // Why: this must stay synchronous up to the `.set()` call so the pending-focus
  // entry exists before the event loop can dispatch a pipelined Input.insertText
  // message, closing the race where the replay would otherwise be silently skipped.
  private forwardDomFocus(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId?: string
  ): void {
    const focused = this.sendDomFocus(client, clientId, params, effectiveSessionId)
    this.pendingDomFocusBySession.set(effectiveSessionId, focused)
  }

  private async sendDomFocus(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId?: string
  ): Promise<Record<string, unknown> | undefined> {
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return undefined
    }
    try {
      const result = await this.sendDebuggerCommand('DOM.focus', params, effectiveSessionId)
      this.sendResult(clientId, result, client)
      return { ...params }
    } catch (err) {
      this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
      return undefined
    }
  }

  private async forwardInsertText(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId?: string
  ): Promise<void> {
    const pendingFocus = this.pendingDomFocusBySession.get(effectiveSessionId)
    this.pendingDomFocusBySession.delete(effectiveSessionId)
    const pendingFocusParams = pendingFocus ? await pendingFocus : undefined
    // Why: the client can disconnect while DOM.focus is in flight; don't replay its
    // focus or forward its insert into the live page once it is no longer active.
    if (!this.isActiveClient(client)) {
      return
    }
    if (pendingFocusParams) {
      if (this.webContents.isDestroyed()) {
        this.sendError(clientId, 'Browser tab is no longer available', client)
        return
      }
      try {
        await this.sendDebuggerCommand('DOM.focus', pendingFocusParams, effectiveSessionId)
      } catch (err) {
        this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
        return
      }
      // Why: the replay DOM.focus also awaited a round-trip; bail if the client vanished
      // during it so its insert never lands in the live page.
      if (!this.isActiveClient(client)) {
        return
      }
    }
    // Why: forwardCommand only queues, so the focus borrow would end before Chromium
    // processed the insert and the text would land in the user's window instead.
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      const result = await this.sendDebuggerCommand('Input.insertText', params, effectiveSessionId)
      this.sendResult(clientId, result, client)
    } catch (err) {
      this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private async handlePrintToPdf(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>
  ): Promise<void> {
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      const pdf = await this.webContents.printToPDF(buildPrintToPdfOptions(params))
      // Why: printToPDF can resolve after the client disconnected (or was
      // replaced). Bail before registering a stream so its buffer isn't
      // orphaned in pdfStreams past the disconnect's clear() until the TTL.
      if (!this.isActiveClient(client)) {
        return
      }
      const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf)
      if (params.transferMode === 'ReturnAsStream') {
        const handle = this.pdfStreams.create(buffer)
        this.sendResult(clientId, { data: '', stream: handle }, client)
        return
      }
      this.sendResult(clientId, { data: buffer.toString('base64') }, client)
    } catch (err) {
      this.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private handleStreamRead(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>
  ): void {
    const chunk = this.pdfStreams.read(params)
    if (!chunk) {
      this.sendError(clientId, 'Invalid stream handle', client)
      return
    }
    this.sendResult(clientId, { base64Encoded: true, data: chunk.data, eof: chunk.eof }, client)
  }

  private handleStreamClose(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>
  ): void {
    this.pdfStreams.close(params)
    this.sendResult(clientId, {}, client)
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
