import { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { isOrcaFrameSessionTraffic } from './guest-focused-frame-route'

export class CdpDebuggerChannel {
  private nativeDebugger: WebContents['debugger'] | null = null
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
    let lease: ElectronDebuggerLease
    try {
      lease = acquireElectronDebugger(this.webContents)
    } catch {
      throw new Error('Could not attach debugger. DevTools may already be open for this tab.')
    }
    const dbg = this.webContents.debugger
    this.nativeDebugger = dbg
    this.debuggerLease = lease
    this.attached = true

    this.debuggerMessageHandler = (_event: unknown, ...rest: unknown[]) => {
      const [method, params, sessionId] = rest as [
        string,
        Record<string, unknown>,
        string | undefined
      ]
      // Hide Orca-owned frame sessions that the client did not request.
      if (isOrcaFrameSessionTraffic(this.webContents, method, params, sessionId || undefined)) {
        return
      }
      const client = this.getClient()
      if (!client || client.readyState !== WebSocket.OPEN) {
        return
      }
      // Electron uses an empty root session ID; agent-browser expects its attachToTarget ID.
      const msg: Record<string, unknown> = { method, params }
      msg.sessionId = sessionId || this.sessions.primarySessionId
      this.responder.send(msg, client)
    }
    this.debuggerDetachHandler = () => {
      this.detachDebugger()
      this.onDetached()
    }
    dbg.on('message', this.debuggerMessageHandler)
    dbg.on('detach', this.debuggerDetachHandler)

    try {
      await dbg.sendCommand('Page.enable', {})
    } catch {
      /* The page domain may not be ready yet. */
    }
    if (this.debuggerLease !== lease) {
      throw new Error('Browser debugger was detached during startup')
    }
    if (this.webContents.isDestroyed() || !dbg.isAttached()) {
      this.detachDebugger()
      throw new Error('Browser tab is no longer available')
    }
  }

  detachDebugger(): void {
    const dbg = this.nativeDebugger
    const messageHandler = this.debuggerMessageHandler
    const detachHandler = this.debuggerDetachHandler
    const lease = this.debuggerLease
    this.nativeDebugger = null
    this.debuggerMessageHandler = null
    this.debuggerDetachHandler = null
    this.debuggerLease = null
    this.attached = false
    try {
      if (messageHandler) {
        dbg?.removeListener('message', messageHandler)
      }
      if (detachHandler) {
        dbg?.removeListener('detach', detachHandler)
      }
    } finally {
      lease?.release()
    }
  }

  sendDebuggerCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    return sessionId
      ? sendGuestCdpCommand(this.webContents, method, params, sessionId)
      : sendGuestCdpCommand(this.webContents, method, params)
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
