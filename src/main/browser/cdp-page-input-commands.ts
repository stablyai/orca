import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpDebuggerChannel } from './cdp-debugger-channel'
import type { CdpDomFocusReplay } from './cdp-dom-focus-replay'
import {
  enablePageFocusEmulation,
  isFocusRoutedCdpInput,
  isFocusTakingCdpInput,
  type AgentInputFocusGuard
} from './agent-input-focus-guard'
import {
  dispatchPageKeyEvent,
  isEmbeddedGuest,
  routePageTextInsertion,
  type GuestCdpSender
} from './guest-direct-key-input'
import { withAgentInputInjection } from './agent-input-injection'

/**
 * CDP `Input.*` for a page: keys and text reach an embedded guest without moving the user's
 * focus, and presses hand it back (docs/reference/agent-browser-focus-isolation.md).
 */
export class CdpPageInputCommands {
  private inputQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly debuggerChannel: CdpDebuggerChannel,
    private readonly domFocusReplay: CdpDomFocusReplay,
    private readonly guardFocus: AgentInputFocusGuard
  ) {}

  /** Handles an `Input.*` command; false when the page is gone and the caller should forward. */
  handle(
    client: WebSocket,
    clientId: number,
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): boolean {
    if (this.webContents.isDestroyed()) {
      return false
    }
    if (method === 'Input.insertText') {
      const pendingFocus = this.domFocusReplay.takePendingFocus(sessionId)
      void this.queueInput(() =>
        this.domFocusReplay.insertText(client, clientId, params, sessionId, pendingFocus, () =>
          sessionId
            ? Promise.resolve({
                deliver: (insertParams: Record<string, unknown>) =>
                  this.debuggerChannel.sendDebuggerCommand(
                    'Input.insertText',
                    insertParams,
                    sessionId
                  ),
                release: () => {}
              })
            : routePageTextInsertion(this.webContents, params, this.sendRoot, this.guardFocus)
        )
      )
      return true
    }
    // Why: a replaced client's queued input must not still land in the page.
    this.reply(
      client,
      clientId,
      this.queueInput(async () =>
        this.responder.isActiveClient(client) ? await this.dispatch(method, params, sessionId) : {}
      )
    )
    return true
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    if (method === 'Input.dispatchKeyEvent' && !sessionId) {
      return await dispatchPageKeyEvent(this.webContents, params, this.sendRoot, this.guardFocus)
    }
    if (!isEmbeddedGuest(this.webContents)) {
      return await this.debuggerChannel.sendDebuggerCommand(method, params, sessionId)
    }
    const send = (): Promise<unknown> =>
      withAgentInputInjection(this.webContents, () =>
        this.debuggerChannel.sendDebuggerCommand(method, params, sessionId)
      )
    const routedByFocus = !sessionId && isFocusRoutedCdpInput(method)
    if (!routedByFocus && !isFocusTakingCdpInput(method, params)) {
      return await send()
    }
    // Why: presses and focus-routed input keep the page's focus emulated and hand the user's back.
    await enablePageFocusEmulation(this.sendRoot)
    const release = await this.guardFocus()
    try {
      if (routedByFocus) {
        this.webContents.focus()
      }
      return await send()
    } finally {
      release()
    }
  }

  private reply(client: WebSocket, clientId: number, result: Promise<unknown>): void {
    result.then(
      (value) => this.responder.sendResult(clientId, value, client),
      (err: unknown) =>
        this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    )
  }

  private readonly sendRoot: GuestCdpSender = (method, params, sessionId) =>
    this.debuggerChannel.sendDebuggerCommand(method, params, sessionId)

  // Why: delivery awaits focus probes and focus guards; one queue keeps a pipelined
  // keyDown/char/keyUp/insertText or press/move/release sequence in order.
  private queueInput<T>(run: () => Promise<T>): Promise<T> {
    const result = this.inputQueue.then(run)
    this.inputQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
