import { getBrowserProcessUserAgentIdentity } from '../../../identity/browser-process-user-agent'
import { resolveBrowserTabIdentity } from '../../../identity/browser-tab-identity'
import {
  hasBrowserGuestFrameUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import { rewritesRequestHeaders } from './browser-manager-navigation'

// An unloading frame leaves the frame tree just after its pagehide.
const SUBFRAME_SETTLE_DELAY_MS = 250
const settleTimers = new Map<number, ReturnType<typeof setTimeout>>()

function subframeRewritesRequestHeaders(url: string): boolean {
  return rewritesRequestHeaders(
    url,
    resolveBrowserTabIdentity({
      url,
      mobile: false,
      processIdentity: getBrowserProcessUserAgentIdentity()
    })
  )
}

/** A site iframe (e.g. Teams inside another page) keeps the header policy on while it shows. */
export function noteBrowserGuestSubframeNavigation(guest: Electron.WebContents, url: string): void {
  if (subframeRewritesRequestHeaders(url)) {
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, true)
  }
}

/** When the page stops loading or an embedded frame unloads: only site iframes still showing keep it. */
export function settleBrowserGuestSubframeDemand(guest: Electron.WebContents): void {
  if (guest.isDestroyed() || !hasBrowserGuestFrameUserAgentDemand(guest.id)) {
    return
  }
  try {
    const { mainFrame } = guest
    const demanding = mainFrame.framesInSubtree.some(
      // A blocked or failed site iframe shows an error page with an opaque origin.
      (frame) =>
        frame !== mainFrame && frame.origin !== 'null' && subframeRewritesRequestHeaders(frame.url)
    )
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, demanding)
  } catch {
    // A disposed frame tree can't prove the site iframe gone; keep the policy on.
  }
}

/** Electron reports no frame removal, so an embedded frame's preload reports its pagehide. */
export function noteBrowserGuestSubframeUnloaded(guest: Electron.WebContents): void {
  if (!hasBrowserGuestFrameUserAgentDemand(guest.id) || settleTimers.has(guest.id)) {
    return
  }
  const timer = setTimeout(() => {
    settleTimers.delete(guest.id)
    settleBrowserGuestSubframeDemand(guest)
  }, SUBFRAME_SETTLE_DELAY_MS)
  timer.unref?.()
  settleTimers.set(guest.id, timer)
}
