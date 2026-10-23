import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpDebuggerChannel } from './cdp-debugger-channel'
import type { TextInsertionRoute } from './guest-direct-key-input'

/**
 * Replays the last DOM.focus immediately before Input.insertText so a native
 * webContents.focus() on the fallback path cannot blur the element the client meant to type into.
 */
export class CdpDomFocusReplay {
  // Why: holds each session's last DOM.focus params to replay right before the next
  // Input.insertText, countering the native webContents.focus() that would blur the target.
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
    // Why: a stored focus is only valid for the immediately following Input.insertText;
    // any other command may have moved DOM focus, so invalidate the replay in one place.
    if (method !== 'DOM.focus' && method !== 'Input.insertText') {
      this.pendingDomFocusBySession.delete(effectiveSessionId)
    }
  }

  // Why: this must stay synchronous up to the `.set()` call so the pending-focus
  // entry exists before the event loop can dispatch a pipelined Input.insertText
  // message, closing the race where the replay would otherwise be silently skipped.
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

  // Why: synchronous so the replay is taken when Input.insertText arrives, before any
  // later command can invalidate it.
  takePendingFocus(
    effectiveSessionId: string | undefined
  ): Promise<Record<string, unknown> | undefined> | undefined {
    const pendingFocus = this.pendingDomFocusBySession.get(effectiveSessionId)
    this.pendingDomFocusBySession.delete(effectiveSessionId)
    return pendingFocus
  }

  /**
   * `chooseRoute` picks how the text is delivered and runs before the replay, because the
   * fallback route focuses the guest natively and that would blur the replayed element.
   */
  async insertText(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    effectiveSessionId: string | undefined,
    pendingFocus: Promise<Record<string, unknown> | undefined> | undefined,
    chooseRoute: () => Promise<TextInsertionRoute>
  ): Promise<void> {
    const pendingFocusParams = pendingFocus ? await pendingFocus : undefined
    // Why: the client can disconnect while DOM.focus is in flight; don't replay its
    // focus or forward its insert into the live page once it is no longer active.
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
      // Why: the replay DOM.focus also awaited a round-trip; bail if the client vanished
      // during it so its insert never lands in the live page.
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
