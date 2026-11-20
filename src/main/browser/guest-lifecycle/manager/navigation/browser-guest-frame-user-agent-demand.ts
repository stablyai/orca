import { webFrameMain } from 'electron'
import { getBrowserProcessUserAgentIdentity } from '../../../identity/browser-process-user-agent'
import { resolveBrowserTabIdentity } from '../../../identity/browser-tab-identity'
import {
  getBrowserGuestFrameUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import { rewritesRequestHeaders } from './browser-manager-navigation'

// An unloading frame leaves the frame tree just after its pagehide.
const REMOVAL_CHECK_DELAY_MS = 250
// One check per guest covers a burst of unloads; churn can't postpone it, and an unload during a
// pending check earns one more pass in case its frame left the tree after that check.
const removalChecks = new Map<number, { again: boolean }>()

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

/** A site iframe (e.g. Teams inside another page) needs rewrites from its first request on. */
export function noteBrowserGuestSubframeNavigation(
  guest: Electron.WebContents,
  url: string,
  frame: Electron.WebFrameMain | null | undefined
): void {
  if (frame && subframeRewritesRequestHeaders(url)) {
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, frame.frameTreeNodeId, true)
  }
}

/**
 * After a subframe commits or fails, its demand follows the document it now shows; a blocked or
 * failed site iframe shows an error page with an opaque origin.
 */
export function settleBrowserGuestSubframe(
  guest: Electron.WebContents,
  frameProcessId: number,
  frameRoutingId: number
): void {
  const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
  if (!frame || guest.isDestroyed()) {
    return
  }
  const demanding = frame.origin !== 'null' && subframeRewritesRequestHeaders(frame.url)
  setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, frame.frameTreeNodeId, demanding)
}

/**
 * Electron reports no frame removal, so a subframe's preload reports its pagehide; site iframes'
 * demand ends once they have left the tree. Unrelated frames' unloads cost a set lookup.
 */
export function noteBrowserGuestSubframeUnloaded(
  guest: Electron.WebContents,
  frame: Electron.WebFrameMain | null | undefined
): void {
  const demanding = getBrowserGuestFrameUserAgentDemand(guest.id)
  // A destroyed sender has no frame; check every site iframe rather than keep its demand.
  if (demanding.size === 0 || (frame && !demanding.has(frame.frameTreeNodeId))) {
    return
  }
  scheduleRemovalCheck(guest)
}

function scheduleRemovalCheck(guest: Electron.WebContents): void {
  const pending = removalChecks.get(guest.id)
  if (pending) {
    pending.again = true
    return
  }
  const check = { again: false }
  removalChecks.set(guest.id, check)
  const timer = setTimeout(() => {
    removalChecks.delete(guest.id)
    if (guest.isDestroyed()) {
      return
    }
    try {
      const present = new Set(guest.mainFrame.framesInSubtree.map((frame) => frame.frameTreeNodeId))
      for (const id of getBrowserGuestFrameUserAgentDemand(guest.id)) {
        if (!present.has(id)) {
          setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, id, false)
        }
      }
    } catch {
      // A disposed frame tree can't prove the site iframes gone; keep the policy on.
    }
    if (check.again && getBrowserGuestFrameUserAgentDemand(guest.id).size > 0) {
      scheduleRemovalCheck(guest)
    }
  }, REMOVAL_CHECK_DELAY_MS)
  timer.unref?.()
}
