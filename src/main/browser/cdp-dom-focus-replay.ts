import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpDebuggerChannel } from './cdp-debugger-channel'
import type { TextInsertionRoute } from './guest-direct-key-input'

/** Replay DOM.focus before insertion because native focusing can blur the target. */
export class CdpDomFocusReplay {
  private pendingDomFocusBySession = new Map<
    string | undefined,
    Promise<Record<string, unknown> | undefined>
  >()

  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly debuggerChannel: CdpDebuggerChannel
  ) {}

  clear(): void {
    this.pendingDomFocusBySession.clear()
  }

  invalidateForMethod(method: string, effectiveSessionId?: string): void {
    // Intervening commands may change focus, invalidating the next-insert replay.
    if (method !== 'DOM.focus' && method !== 'Input.insertText') {
      this.pendingDomFocusBySession.delete(effectiveSessionId)
    }
  }

  // Store synchronously so a pipelined insert sees the pending DOM.focus.
  forwardDomFocus(
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
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return undefined
    }
    try {
      const result = await this.debuggerChannel.sendDebuggerCommand(
        'DOM.focus',
        params,
        effectiveSessionId
      )
      this.responder.sendResult(clientId, result, client)
      return { ...params }
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
      return undefined
    }
  }

  // Consume synchronously before a later command can invalidate the replay.
  takePendingFocus(
    effectiveSessionId: string | undefined
  ): Promise<Record<string, unknown> | undefined> | undefined {
    const pendingFocus = this.pendingDomFocusBySession.get(effectiveSessionId)
    this.pendingDomFocusBySession.delete(effectiveSessionId)
    return pendingFocus
  }

  /** Choose the route before replay: native fallback focus can blur the target. */
  async insertText(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId: string | undefined,
    pendingFocus: Promise<Record<string, unknown> | undefined> | undefined,
    chooseRoute: () => Promise<TextInsertionRoute>
  ): Promise<void> {
    const pendingFocusParams = pendingFocus ? await pendingFocus : undefined
    // The client may disconnect while DOM.focus is pending.
    if (!this.responder.isActiveClient(client)) {
      return
    }
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    let route: TextInsertionRoute
    try {
      route = await chooseRoute()
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
      return
    }
    try {
      await this.replayAndDeliver(
        client,
        clientId,
        params,
        effectiveSessionId,
        pendingFocusParams,
        route
      )
    } finally {
      route.release()
    }
  }

  private async replayAndDeliver(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId: string | undefined,
    pendingFocusParams: Record<string, unknown> | undefined,
    route: TextInsertionRoute
  ): Promise<void> {
    if (pendingFocusParams) {
      if (this.webContents.isDestroyed()) {
        this.responder.sendError(clientId, 'Browser tab is no longer available', client)
        return
      }
      try {
        await this.debuggerChannel.sendDebuggerCommand(
          'DOM.focus',
          pendingFocusParams,
          effectiveSessionId
        )
      } catch (err) {
        this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
        return
      }
      // Replay also awaited a round trip; discard inserts from a disconnected client.
      if (!this.responder.isActiveClient(client)) {
        return
      }
    }
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      this.responder.sendResult(clientId, await route.deliver(params), client)
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }
}
