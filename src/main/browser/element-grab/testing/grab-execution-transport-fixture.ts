import type { EventEmitter } from 'node:events'
import { installBrowserGuestExecution } from '../../../../preload/browser/element-grab/browser-guest-execution'
import type { GrabExecutionRequest } from '../../../../shared/browser/element-grab/grab-execution-protocol'
import type { BrowserGuestPickerAuthority } from '../../../../preload/browser/element-grab/browser-guest-picker-authority'

/** Only replaces the IPC transport; supplied guest script implementations produce the real result. */
export function attachGrabExecutionTransport<
  T extends EventEmitter & {
    executeJavaScript?: (code: string) => Promise<unknown>
    getURL?: () => string
    // Supplied by a guest that models loading; otherwise the main frame is always loaded.
    isLoadingMainFrame?: () => boolean
    executeJavaScriptInIsolatedWorld?: (
      world: number,
      scripts: { code: string }[]
    ) => Promise<unknown>
  }
>(
  guest: T,
  authority?: BrowserGuestPickerAuthority | null
): T & { mainFrame: Electron.WebFrameMain; isLoadingMainFrame: () => boolean } {
  const listeners = new Map<string, (request: GrabExecutionRequest) => void>()
  const install = (): void => {
    installBrowserGuestExecution(
      {
        on: (channel, listener) => listeners.set(channel, listener),
        send: (channel, payload) =>
          queueMicrotask(() => guest.emit('ipc-message', { senderFrame: frame }, channel, payload))
      },
      {
        executeJavaScript: (code) => guest.executeJavaScript?.(code) ?? Promise.resolve(undefined),
        executeJavaScriptInIsolatedWorld: (world, scripts) =>
          guest.executeJavaScriptInIsolatedWorld?.(world, scripts) ?? Promise.resolve(undefined)
      },
      undefined,
      authority
    )
  }
  const frame = {
    send: (channel: string, request: GrabExecutionRequest): void => {
      queueMicrotask(() => listeners.get(channel)?.(request))
    }
  }
  guest.on('did-start-navigation', (_event, _url, inPlace, main) => {
    if (main && !inPlace) {
      install()
    }
  })
  install()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the execution transport uses only frame.send and sender-frame object identity.
  const senderFrame = frame as unknown as Electron.WebFrameMain
  return Object.assign(guest, {
    mainFrame: senderFrame,
    isLoadingMainFrame: guest.isLoadingMainFrame ?? (() => false),
    getURL: guest.getURL ?? (() => 'https://synthetic.invalid/')
  })
}
