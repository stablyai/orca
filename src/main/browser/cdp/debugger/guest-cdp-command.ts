import type { WebContents } from 'electron'
import { BrowserError } from '../../browser-error'
import { withAgentInputInjection } from '../input/agent-input-injection'
import { sendOffscreenPagePointerInput } from '../input/offscreen-frame-pointer-route'
import {
  readRemoteCliAdmittedPage,
  trackRemoteCliInput
} from '../../routing/input-ownership/remote-cli-page-admission'

// Resizing a crashed guest dereferences its missing Chromium view and can segfault main.
const VIEW_RESIZING_CDP_METHODS: ReadonlySet<string> = new Set([
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setVisibleSize'
])

/** Gate viewport and passthrough CDP commands against crashed guests. */
export function sendGuestCdpCommand(
  guest: WebContents,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<unknown> {
  const send = (): Promise<unknown> => {
    // Check and send in one task: isCrashed flips in the task that removes the view.
    if (VIEW_RESIZING_CDP_METHODS.has(method) && (guest.isDestroyed() || guest.isCrashed())) {
      return Promise.reject(
        new BrowserError(
          'browser_cdp_error',
          'The page crashed; its viewport can be changed again once it reloads.'
        )
      )
    }
    const sendRaw = (
      rawMethod: string,
      rawParams?: Record<string, unknown>,
      rawSessionId?: string
    ): Promise<unknown> =>
      Promise.resolve(
        rawSessionId === undefined
          ? guest.debugger.sendCommand(rawMethod, rawParams)
          : guest.debugger.sendCommand(rawMethod, rawParams, rawSessionId)
      )
    return trackRemoteCliInput(guest.id, method, params, () =>
      method === 'Input.dispatchMouseEvent' &&
      sessionId === undefined &&
      params &&
      guest.isOffscreen()
        ? sendOffscreenPagePointerInput(guest, sendRaw, params)
        : sendRaw(method, params, sessionId)
    )
  }
  // Input already sent remains valid after revocation; its response carries no page data.
  if (method.startsWith('Input.')) {
    // Why: every Input sent here is an agent's or a remote viewer's, never this desktop user's, so
    // the guest's own handlers must not read it as a reason to move splits, history or shortcuts.
    return withAgentInputInjection(guest, send)
  }
  return readRemoteCliAdmittedPage(guest.id, send)
}
