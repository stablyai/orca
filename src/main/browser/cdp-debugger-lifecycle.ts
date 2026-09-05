import type { WebContents } from 'electron'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender } from './snapshot-engine'
import type { CdpBridgeState } from './cdp-bridge-state'
import { createCdpDebuggerMessageListener } from './cdp-debugger-events'

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
      // Why: BrowserManager already attached the debugger; reuse it to avoid "another debugger is already attached."
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

    // Why: OOPIF iframes are invisible to the parent CDP session; flatten:true gives each a targetable sessionId.
    await sender('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })

    // Why: CDP attach exposes automation signals (navigator.webdriver) that Cloudflare checks; override per new document.
    await sender('Page.addScriptToEvaluateOnNewDocument', {
      source: ANTI_DETECTION_SCRIPT
    })

    // Why: only remove this bridge's listeners; screencast/proxy sessions share the debugger and own their teardown.
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
      const command = guest.debugger.sendCommand(method, params, sessionId) as Promise<unknown>
      // Why: Electron's CDP sendCommand can hang on a stale debugger session, so a 10s timeout bounds the RPC.
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
