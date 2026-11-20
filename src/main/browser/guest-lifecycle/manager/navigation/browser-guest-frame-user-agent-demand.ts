import { webFrameMain } from 'electron'
import { getBrowserProcessUserAgentIdentity } from '../../../identity/browser-process-user-agent'
import { resolveBrowserTabIdentity } from '../../../identity/browser-tab-identity'
import {
  hasBrowserGuestFrameUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import { rewritesRequestHeaders } from './browser-manager-navigation'

// An unloading frame leaves the frame tree just after its pagehide.
const REMOVAL_CHECK_DELAY_MS = 250
const removalChecks = new Map<string, ReturnType<typeof setTimeout>>()

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
 * Electron reports no frame removal, so a site iframe's preload reports its pagehide; its
 * demand ends once the frame has left the tree. Unrelated frames' unloads cost a map lookup.
 */
export function noteBrowserGuestSubframeUnloaded(
  guest: Electron.WebContents,
  frame: Electron.WebFrameMain | null | undefined
): void {
  const frameTreeNodeId = frame?.frameTreeNodeId
  if (
    frameTreeNodeId === undefined ||
    !hasBrowserGuestFrameUserAgentDemand(guest.id, frameTreeNodeId)
  ) {
    return
  }
  const key = `${guest.id}:${frameTreeNodeId}`
  clearTimeout(removalChecks.get(key))
  const timer = setTimeout(() => {
    removalChecks.delete(key)
    if (guest.isDestroyed()) {
      return
    }
    try {
      const present = guest.mainFrame.framesInSubtree.some(
        (candidate) => candidate.frameTreeNodeId === frameTreeNodeId
      )
      if (!present) {
        setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, frameTreeNodeId, false)
      }
    } catch {
      // A disposed frame tree can't prove the site iframe gone; keep the policy on.
    }
  }, REMOVAL_CHECK_DELAY_MS)
  timer.unref?.()
  removalChecks.set(key, timer)
}
