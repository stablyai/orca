import type { WebContents } from 'electron'
import { sendGuestCdpCommandWithTimeout } from '../browser/guest-cdp-command'
import type { VoiceCdpDebugger } from './voice-control-screen-driver'

/**
 * One stable VoiceCdpDebugger wrapper per webContents. The screen driver
 * identity-compares wrappers to tell its own attachment from the user's DevTools —
 * the wiring used to return a fresh object literal per call, so from the second
 * see_screen on, the driver refused its OWN attachment as 'refused-devtools-held'
 * (live: an entire session blind after the first read_terminal, with the user
 * insisting — correctly — that no DevTools was open). WeakMap-keyed: a closed
 * window's wrapper dies with its webContents.
 */
export function createVoiceOwnerDebuggerCache(): {
  forWebContents: (webContents: WebContents) => VoiceCdpDebugger
} {
  const cache = new WeakMap<WebContents, VoiceCdpDebugger>()
  return {
    forWebContents(webContents) {
      const cached = cache.get(webContents)
      if (cached) {
        return cached
      }
      const wrapper: VoiceCdpDebugger = {
        isAttached: () => webContents.debugger.isAttached(),
        attach: (protocolVersion) => webContents.debugger.attach(protocolVersion),
        on: (event, listener) => {
          webContents.debugger.on(event, listener)
        },
        // The shared timeout guard: a stale debugger session can hang the RPC.
        sendCommand: (method, params) => sendGuestCdpCommandWithTimeout(webContents, method, params)
      }
      cache.set(webContents, wrapper)
      return wrapper
    }
  }
}
