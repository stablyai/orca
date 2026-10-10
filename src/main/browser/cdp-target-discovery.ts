import type { WebSocket } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'

/**
 * The Chrome-lookalike identity surface: HTTP discovery endpoints and the
 * Target/Browser commands answered from local state without the real debugger.
 */
export class CdpTargetDiscovery {
  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly sessions: CdpSyntheticSessionRegistry,
    private readonly getPort: () => number
  ) {}

  handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
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
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.getPort()}`
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
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.getPort()}`
          }
        ])
      )
      return
    }
    res.writeHead(404)
    res.end()
  }

  /** Returns true when the command was answered locally and needs no forwarding. */
  handleCommand(
    client: WebSocket,
    clientId: number,
    msg: { method?: string; params?: Record<string, unknown> }
  ): boolean {
    if (msg.method === 'Target.getTargets') {
      this.responder.sendResult(clientId, { targetInfos: [this.buildTargetInfo()] }, client)
      return true
    }
    if (msg.method === 'Target.getTargetInfo') {
      this.responder.sendResult(clientId, { targetInfo: this.buildTargetInfo() }, client)
      return true
    }
    if (msg.method === 'Target.setDiscoverTargets' || msg.method === 'Target.detachFromTarget') {
      if (msg.method === 'Target.detachFromTarget') {
        const detachedSessionId = msg.params?.sessionId
        this.sessions.detachSession(detachedSessionId)
      }
      this.responder.sendResult(clientId, {}, client)
      return true
    }
    if (msg.method === 'Target.attachToBrowserTarget') {
      const sessionId = this.sessions.attachBrowserSession()
      this.responder.sendResult(clientId, { sessionId }, client)
      return true
    }
    if (msg.method === 'Target.attachToTarget') {
      const sessionId = this.sessions.attachPageSession()
      this.responder.sendResult(clientId, { sessionId }, client)
      return true
    }
    if (msg.method === 'Browser.getVersion') {
      // Why: returning "Orca/Electron" identifies this as an embedded automation
      // surface to agent-browser. Use a generic Chrome product string instead.
      const chromeVersion = process.versions.chrome ?? '134.0.0.0'
      this.responder.sendResult(
        clientId,
        {
          protocolVersion: '1.3',
          product: `Chrome/${chromeVersion}`,
          userAgent: '',
          jsVersion: ''
        },
        client
      )
      return true
    }
    return false
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
}
