import { webFrameMain } from 'electron'
import { getBrowserProcessUserAgentIdentity } from '../../../identity/browser-process-user-agent'
import { resolveBrowserTabIdentity } from '../../../identity/browser-tab-identity'
import {
  clearBrowserGuestUserAgentDemand,
  getBrowserGuestFrameUserAgentDemand,
  setBrowserGuestFrameUserAgentDemand,
  setBrowserGuestPageUserAgentDemand
} from '../../../identity/requests/browser-session-ua-demand'
import { browserSessionHeaderListenerIgnoresDemand } from '../../../identity/requests/browser-session-ua'
import { rewritesRequestHeaders } from './browser-manager-navigation'

// An unloading frame leaves the frame tree just after its pagehide.
const REMOVAL_CHECK_DELAY_MS = 250
const POPUP_FRAME_RECHECK_MS = { first: 2_000, last: 16_000 }
// One check per guest covers a burst of unloads; churn can't postpone it, and an unload during a
// pending check earns one more pass in case its frame left the tree after that check.
const removalChecks = new Map<number, { again: boolean }>()
// The frame each tracked site iframe was last seen as, so a check visits only those frames.
const trackedFrames = new WeakMap<Electron.WebContents, Map<number, Electron.WebFrameMain>>()

function track(
  guest: Electron.WebContents,
  frame: Electron.WebFrameMain,
  demanding: boolean
): void {
  let frames = trackedFrames.get(guest)
  if (!frames) {
    frames = new Map()
    trackedFrames.set(guest, frames)
  }
  if (demanding) {
    frames.set(frame.frameTreeNodeId, frame)
  } else {
    frames.delete(frame.frameTreeNodeId)
  }
  // A page commit drops all iframe demand; frames it left behind go with the next change. Only
  // then are there more frames than demand, so the walk runs once per commit, not per update.
  const demand = getBrowserGuestFrameUserAgentDemand(guest.id)
  if (frames.size > demand.size) {
    for (const id of frames.keys()) {
      if (!demand.has(id)) {
        frames.delete(id)
      }
    }
  }
}

/** Frames held for one guest's site iframes; a perf contract keeps it flat across navigations. */
export function countTrackedBrowserGuestFrames(guest: Electron.WebContents): number {
  return trackedFrames.get(guest)?.size ?? 0
}

// Removed, or replaced by a document that never committed to this frame.
function frameGone(frame: Electron.WebFrameMain | undefined): boolean {
  try {
    return !frame || frame.isDestroyed() || frame.detached
  } catch {
    return true
  }
}

function defaultIdentityRewritesRequestHeaders(url: string): boolean {
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
  if (frame && defaultIdentityRewritesRequestHeaders(url)) {
    const isNew = !getBrowserGuestFrameUserAgentDemand(guest.id).has(frame.frameTreeNodeId)
    setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, frame.frameTreeNodeId, true)
    track(guest, frame, true)
    // A site iframe removed before it committed reports nothing; each new one sweeps those out,
    // so dead entries never outnumber live frames.
    if (isNew && getBrowserGuestFrameUserAgentDemand(guest.id).size > 1) {
      scheduleRemovalCheck(guest)
    }
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
  const demanding = frame.origin !== 'null' && defaultIdentityRewritesRequestHeaders(frame.url)
  setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, frame.frameTreeNodeId, demanding)
  track(guest, frame, demanding)
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
    // A commit or settle since scheduling may have cleared every site iframe; skip the tree walk.
    if (guest.isDestroyed() || getBrowserGuestFrameUserAgentDemand(guest.id).size === 0) {
      trackedFrames.delete(guest)
      return
    }
    const frames = trackedFrames.get(guest)
    const demanding = getBrowserGuestFrameUserAgentDemand(guest.id)
    // Deleting the current entry while iterating a Set is safe.
    for (const id of demanding) {
      if (frameGone(frames?.get(id))) {
        setBrowserGuestFrameUserAgentDemand(guest.session, guest.id, id, false)
      }
    }
    if (check.again && getBrowserGuestFrameUserAgentDemand(guest.id).size > 0) {
      scheduleRemovalCheck(guest)
    }
  }, REMOVAL_CHECK_DELAY_MS)
  timer.unref?.()
}

/**
 * Popup windows run no guest preload in their iframes to report an unload, and Electron 43 reports
 * frame creation but not removal. So each new site iframe earns a few checks of the tracked frames
 * (only those, not the frame tree), 2 s to 16 s apart, then none: an idle popup does no work, and
 * an iframe removed later keeps the header listener (as every session had before) until the popup
 * navigates or closes. Call after the listener that notes the popup's subframe navigations.
 */
export function watchBrowserPopupSiteFrameRemoval(contents: Electron.WebContents): void {
  const { id, session } = contents
  let recheck: NodeJS.Timeout | null = null
  // Site iframes whose checks already ran or are running, for the current document's demand (a
  // page commit replaces that set, which starts this one over).
  let watched = new Set<number>()
  let watchedDemand: ReadonlySet<number> | null = null
  const scheduleRecheck = (delay: number): void => {
    recheck = setTimeout(() => {
      recheck = null
      if (
        contents.isDestroyed() ||
        getBrowserGuestFrameUserAgentDemand(id).size === 0 ||
        browserSessionHeaderListenerIgnoresDemand(session)
      ) {
        return
      }
      scheduleRemovalCheck(contents)
      if (delay < POPUP_FRAME_RECHECK_MS.last) {
        scheduleRecheck(delay * 2)
      }
    }, delay)
    recheck.unref?.()
  }
  const onSubframeStart = (
    details: Electron.Event<{ isMainFrame: boolean; frame?: Electron.WebFrameMain | null }>
  ): void => {
    if (details.isMainFrame) {
      return
    }
    const demand = getBrowserGuestFrameUserAgentDemand(id)
    if (demand !== watchedDemand) {
      watched = new Set()
      watchedDemand = demand
    } else if (watched.size > demand.size) {
      // Only cleared iframes leave watched larger than demand, so the walk runs once per clearing.
      for (const frameTreeNodeId of watched) {
        if (!demand.has(frameTreeNodeId)) {
          watched.delete(frameTreeNodeId)
        }
      }
    }
    const frameTreeNodeId = details.frame?.frameTreeNodeId
    if (
      frameTreeNodeId === undefined ||
      !demand.has(frameTreeNodeId) ||
      watched.has(frameTreeNodeId)
    ) {
      return
    }
    watched.add(frameTreeNodeId)
    if (recheck) {
      clearTimeout(recheck)
    }
    scheduleRecheck(POPUP_FRAME_RECHECK_MS.first)
  }
  contents.on('did-start-navigation', onSubframeStart)
  contents.on('did-redirect-navigation', onSubframeStart)
  contents.on('destroyed', () => {
    if (recheck) {
      clearTimeout(recheck)
    }
  })
}

/**
 * Route popups skip the tab manager, so their demand is noted here: a navigation's target needs
 * rewrites from its first request, the committed page until the next commit, and site iframes as
 * in a tab.
 */
export function trackBrowserPopupUserAgentDemand(contents: Electron.WebContents): void {
  const { id, session } = contents
  const onStart = (
    details: Electron.Event<{
      url: string
      isMainFrame: boolean
      frame?: Electron.WebFrameMain | null
    }>
  ): void => {
    if (!details.isMainFrame) {
      noteBrowserGuestSubframeNavigation(contents, details.url, details.frame)
    } else {
      setBrowserGuestPageUserAgentDemand(
        session,
        id,
        defaultIdentityRewritesRequestHeaders(details.url) ||
          defaultIdentityRewritesRequestHeaders(contents.getURL())
      )
    }
  }
  contents.on('did-start-navigation', onStart)
  contents.on('did-redirect-navigation', onStart)
  watchBrowserPopupSiteFrameRemoval(contents)
  contents.on('did-navigate', () => {
    setBrowserGuestPageUserAgentDemand(
      session,
      id,
      defaultIdentityRewritesRequestHeaders(contents.getURL()),
      'clear'
    )
  })
  contents.on(
    'did-fail-provisional-load',
    (_event, _code, _description, _url, isMainFrame, frameProcessId, frameRoutingId) => {
      if (!isMainFrame) {
        settleBrowserGuestSubframe(contents, frameProcessId, frameRoutingId)
      }
    }
  )
  contents.on(
    'did-frame-navigate',
    (_event, _url, _code, _status, isMainFrame, frameProcessId, frameRoutingId) => {
      if (!isMainFrame) {
        settleBrowserGuestSubframe(contents, frameProcessId, frameRoutingId)
      }
    }
  )
  contents.once('destroyed', () => {
    clearBrowserGuestUserAgentDemand(id)
  })
}
