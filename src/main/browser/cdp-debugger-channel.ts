import { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'

/**
 * The IO boundary with webContents.debugger: lease-based attach, event fan-out to
 * the websocket client, detach teardown, and generic command forwarding.
 */
export class CdpDebuggerChannel {
  private debuggerMessageHandler: ((...args: unknown[]) => void) | null = null
  private debuggerDetachHandler: ((...args: unknown[]) => void) | null = null
  private debuggerLease: ElectronDebuggerLease | null = null
  private attached = false

  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly sessions: CdpSyntheticSessionRegistry,
    private readonly getClient: () => WebSocket | null,
    private readonly onDetached: () => void
  ) {}

  async attachDebugger(): Promise<void> {
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
      const client = this.getClient()
      if (!client || client.readyState !== WebSocket.OPEN) {
        return
      }
      // Why: Electron passes empty string (not undefined) for root-session events, but
      // agent-browser filters events by the sessionId from Target.attachToTarget.
      const msg: Record<string, unknown> = { method, params }
      msg.sessionId = sessionId || this.sessions.primarySessionId
      client.send(JSON.stringify(msg))
    }
    this.debuggerDetachHandler = () => {
      this.attached = false
      const lease = this.debuggerLease
      this.debuggerLease = null
      lease?.release()
      this.onDetached()
    }
    this.webContents.debugger.on('message', this.debuggerMessageHandler as never)
    this.webContents.debugger.on('detach', this.debuggerDetachHandler as never)
  }

  detachDebugger(): void {
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

  sendDebuggerCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const command = sessionId
      ? this.webContents.debugger.sendCommand(method, params, sessionId)
      : this.webContents.debugger.sendCommand(method, params)
    return Promise.resolve(command)
  }

  forwardCommand(
    client: WebSocket,
    clientId: number,
    method: string,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): void {
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    const sessionId = this.sessions.resolveDebuggerSessionId(msgSessionId)
    try {
      this.sendDebuggerCommand(method, params, sessionId)
        .then((result) => {
          this.responder.sendResult(clientId, result, client)
        })
        .catch((err: Error) => {
          this.responder.sendError(clientId, err.message, client)
        })
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }
}
