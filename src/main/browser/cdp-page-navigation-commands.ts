import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'
import type { CdpDebuggerChannel } from './cdp-debugger-channel'

const LIFECYCLE_PRIMING_TIMEOUT_MS = 1_000

/** Re-prime lifecycle subscriptions lost during Electron process swaps (#7031). */
export class CdpPageNavigationCommands {
  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly sessions: CdpSyntheticSessionRegistry,
    private readonly debuggerChannel: CdpDebuggerChannel
  ) {}

  async navigateWithLifecycle(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): Promise<void> {
    await this.primePageLifecycle(this.sessions.resolveDebuggerSessionId(msgSessionId))
    if (!this.responder.isActiveClient(client)) {
      return
    }
    this.debuggerChannel.forwardCommand(client, clientId, 'Page.navigate', params, msgSessionId)
  }

  async reloadWithLifecycle(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): Promise<void> {
    const sessionId = this.sessions.resolveDebuggerSessionId(msgSessionId)
    const unsupportedParam = sessionId ? null : this.getUnsupportedRootReloadParam(params)
    if (unsupportedParam) {
      this.responder.sendError(
        clientId,
        `Page.reload parameter "${unsupportedParam}" is not supported for Orca tab reloads`,
        client
      )
      return
    }
    await this.primePageLifecycle(sessionId)
    if (!this.responder.isActiveClient(client)) {
      return
    }
    if (sessionId) {
      this.debuggerChannel.forwardCommand(client, clientId, 'Page.reload', params, msgSessionId)
      return
    }
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      if (params.ignoreCache === true) {
        this.webContents.reloadIgnoringCache()
      } else {
        this.webContents.reload()
      }
      this.responder.sendResult(clientId, {}, client)
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private getUnsupportedRootReloadParam(params: Record<string, unknown>): string | null {
    return Object.keys(params).find((key) => key !== 'ignoreCache') ?? null
  }

  private async primePageLifecycle(sessionId?: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const priming = (async (): Promise<void> => {
      // agent-browser needs Network.enable to observe network idle and finish navigation.
      await this.debuggerChannel.sendDebuggerCommand('Network.enable', {}, sessionId)
      await this.debuggerChannel.sendDebuggerCommand('Page.enable', {}, sessionId)
      await this.debuggerChannel.sendDebuggerCommand(
        'Page.setLifecycleEventsEnabled',
        { enabled: true },
        sessionId
      )
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
}
