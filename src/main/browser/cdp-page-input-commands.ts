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
import type { AgentPointerInput } from './browser-agent-activity'

/** Shows the agent's pointer at an input's point and resolves once it has landed. */
export type ShowAgentPointer = (input: AgentPointerInput) => Promise<void>

/** Protect user focus while routing CDP input (docs/reference/agent-browser-focus-isolation.md). */
export class CdpPageInputCommands {
  private inputQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly debuggerChannel: CdpDebuggerChannel,
    private readonly domFocusReplay: CdpDomFocusReplay,
    private readonly guardFocus: AgentInputFocusGuard,
    private readonly showAgentPointer: ShowAgentPointer
  ) {}

  /** Points the agent cursor at a DOM node the agent is about to act on without pointer input. */
  async pointAtNode(backendNodeId: unknown): Promise<void> {
    if (typeof backendNodeId !== 'number') {
      return
    }
    try {
      const box = await this.debuggerChannel.sendDebuggerCommand('DOM.getBoxModel', {
        backendNodeId
      })
      const model = box !== null && typeof box === 'object' && 'model' in box ? box.model : null
      const quad =
        model !== null && typeof model === 'object' && 'content' in model ? model.content : null
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) {
        return
      }
      await this.showAgentPointer({
        type: 'mouseMoved',
        x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
        y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
      })
    } catch {
      // A node without a box (hidden, detached) just gets no cursor.
    }
  }

  /** False tells the caller to forward commands for a destroyed page. */
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
    // Replaced clients must not deliver queued input to the page.
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
    // Frame sessions use frame-local points, so only root-session pointers are shown.
    if (method === 'Input.dispatchMouseEvent' && !sessionId) {
      await this.showAgentPointer(params)
    }
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
    // Emulate page focus while the pane guards and restores user focus.
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

  // Focus awaits must not reorder pipelined key, text, or pointer events.
  private queueInput<T>(run: () => Promise<T>): Promise<T> {
    const result = this.inputQueue.then(run)
    this.inputQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
