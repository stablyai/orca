import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender } from './snapshot-engine'
import type { CdpBridgeState } from './cdp-bridge-state'
import { createCdpDebuggerMessageListener } from './cdp-debugger-events'
import { sendGuestCdpCommand } from './guest-cdp-command'

export class CdpDebuggerLifecycle {
  constructor(private readonly bridgeState: CdpBridgeState) {}

  removeDebuggerListeners(guest: WebContents, state: CdpTabState): void {
    const detachListener = state.debuggerDetachListener
    const messageListener = state.debuggerMessageListener
    state.debuggerDetachListener = null
    state.debuggerMessageListener = null

    if (detachListener) {
      try {
        guest.debugger.removeListener('detach', detachListener as never)
      } catch {
        // guest may already be destroyed
      }
    }
    if (messageListener) {
      try {
        guest.debugger.removeListener('message', messageListener as never)
      } catch {
        // guest may already be destroyed
      }
    }
  }

  async ensureDebuggerAttached(guest: WebContents): Promise<void> {
    const tabId = this.bridgeState.resolveTabId(guest.id)
    const state = this.bridgeState.getOrCreateTabState(tabId)
    if (state.debuggerAttached && guest.debugger.isAttached()) {
      return
    }

    try {
      // Reuse BrowserManager’s attachment to avoid a second-debugger error.
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch {
      throw new BrowserError(
        'browser_cdp_error',
        'Could not attach debugger. DevTools may already be open for this tab.'
      )
    }

    const sender = this.makeCdpSender(guest)
    await sender('Page.enable')
    await sender('DOM.enable')
    await sender('Network.enable')

    // Out-of-process iframes need flattened sessions to receive commands.
    await sender('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })

    // Screencast and proxy clients own their listeners on this shared debugger.
    this.removeDebuggerListeners(guest, state)

    const detachListener = (): void => {
      state.debuggerAttached = false
      state.snapshotResult = null
      state.iframeSessions.clear()
      this.removeDebuggerListeners(guest, state)
    }

    const messageListener = createCdpDebuggerMessageListener(guest, state)

    state.debuggerDetachListener = detachListener
    state.debuggerMessageListener = messageListener
    guest.debugger.on('detach', detachListener)
    guest.debugger.on('message', messageListener)

    state.debuggerAttached = true
  }

  makeCdpSender(guest: WebContents, sessionId?: string): CdpCommandSender {
    return (method: string, params?: Record<string, unknown>) => {
      const command = sendGuestCdpCommand(guest, method, params, sessionId)
      // Stale debugger sessions can hang; bound the RPC to 10 seconds.
      let timer: ReturnType<typeof setTimeout>
      return Promise.race([
        command.finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new BrowserError('browser_cdp_error', `CDP command "${method}" timed out`)),
            10_000
          )
        })
      ])
    }
  }
}
