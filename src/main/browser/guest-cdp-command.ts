import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'

// Why: Chromium resizes the page's view for these without checking the view still exists
// (WebContentsImpl::SetDeviceEmulationSize). A crashed renderer takes its view with it until the
// reload builds a new one, so one of these sent in that gap segfaults Orca's main process.
const VIEW_RESIZING_CDP_METHODS: ReadonlySet<string> = new Set([
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setVisibleSize'
])

type GuestCdpTarget = Pick<WebContents, 'isDestroyed' | 'isCrashed'> & {
  debugger: Pick<WebContents['debugger'], 'sendCommand'>
}

/**
 * The gate for guest CDP commands: every viewport writer and every sender that forwards a caller's
 * method (agent bridge, CDP proxy) goes through here, so none can hand Chromium a command that
 * crashes the app while the guest's renderer is dead.
 */
export function sendGuestCdpCommand(
  guest: GuestCdpTarget,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<unknown> {
  // Why same task as the send: isCrashed() flips in the same Chromium task that drops the view,
  // so checking right before sendCommand leaves no gap for the renderer to die in between.
  if (VIEW_RESIZING_CDP_METHODS.has(method) && (guest.isDestroyed() || guest.isCrashed())) {
    return Promise.reject(
      new BrowserError(
        'browser_cdp_error',
        'The page crashed; its viewport can be changed again once it reloads.'
      )
    )
  }
  return Promise.resolve(
    sessionId === undefined
      ? guest.debugger.sendCommand(method, params)
      : guest.debugger.sendCommand(method, params, sessionId)
  )
}
