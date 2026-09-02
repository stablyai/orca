import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

/** The trusted renderer hosting the preview: the sink for link reports and the only sender allowed to drive tools on it. */
type PreviewHostRenderer = {
  id: number
  send: (channel: string, payload: { url: string }) => void
}

type PreviewGuestRegistration = {
  host: PreviewHostRenderer
  readBoundGrantId: () => string | null
}

/**
 * Why a registry: the click report arrives on an IPC channel, where the only thing main holds is
 * the sender. Without this, "is this a live preview guest, and which grant is it bound to" has no
 * answer, and any WebContents that learned the channel name would be routed out.
 */
const previewGuests = new WeakMap<object, PreviewGuestRegistration>()

/**
 * The workspace-document half of the browser page registry, keyed by the page the reader opened
 * the document in. It is deliberately a separate map from the browsing one: page management,
 * agent commands, download routing and certificate attribution all read that map directly, in
 * more places than a guard could be remembered in, so a document guest is simply not in it. The
 * one door taught about both is `browserManager.getAuthorizedGuest`, because acting on the guest
 * the reader is looking at is the single operation that legitimately spans them.
 */
const docGuestsByPageId = new Map<
  string,
  { guest: Electron.WebContents; hostId: number; grantId: string }
>()

const registrationListeners = new Set<(browserPageId: string) => void>()

/** Why anything listens: a tool request can beat the guest's own attach, and the wait it parks in lives in the IPC layer. */
export function onWorkspaceDocGuestRegistered(
  listener: (browserPageId: string) => void
): () => void {
  registrationListeners.add(listener)
  return () => registrationListeners.delete(listener)
}

/**
 * Resolve the document guest a browser tool should act on. Grants the guest nothing — it answers
 * only whether the trusted renderer asking is the one hosting a live, grant-bound preview on that
 * page. Reached only through `browserManager.getAuthorizedGuest`.
 */
export function getWorkspaceDocPageGuest(
  browserPageId: string,
  senderWebContentsId: number
): Electron.WebContents | null {
  const registration = docGuestsByPageId.get(browserPageId)
  if (!registration || registration.hostId !== senderWebContentsId) {
    return null
  }
  // Why: revocation is how a closed tab withdraws its preview, and it happens before the guest is torn down.
  if (!getDocPreviewGrant(registration.grantId)) {
    return null
  }
  if (registration.guest.isDestroyed()) {
    docGuestsByPageId.delete(browserPageId)
    return null
  }
  return registration.guest
}

/** True when the page renders a workspace document, so the browsing registry must never hold it. */
export function isWorkspaceDocPageId(browserPageId: string): boolean {
  return docGuestsByPageId.has(browserPageId)
}

/**
 * The grant a live preview guest is bound to, or null for any other WebContents — the same identity
 * question `reportDocPreviewLinkClick` asks, for a session event that hands over only the contents.
 */
export function readDocPreviewGuestBoundGrantId(guest: Electron.WebContents): string | null {
  return previewGuests.get(guest)?.readBoundGrantId() ?? null
}

/**
 * The preview guest renders a workspace document, not the web: it may only move within its own
 * grant, and nothing it does by itself leaves the preview. The one route out is
 * `reportDocPreviewLinkClick`, which answers for a click the reader really made.
 *
 * Reached only through `browserManager.attachGuestPolicies` under the workspace-doc profile, so
 * every guest in the app is policy-attached by one door whatever it renders. Returns the disposal
 * that door stores: without it a retired guest keeps its listeners and stays answerable through the
 * grant-keyed authority until the WebContents itself is collected.
 */
export function installDocPreviewGuestPolicy(
  guest: Electron.WebContents,
  host: PreviewHostRenderer
): () => void {
  // Why: the first commit is the renderer-set src, already admitted by will-attach-webview;
  // latching it pins every later navigation to that one grant.
  let boundGrantId: string | null = null
  let boundPageId: string | null = null

  const latchGrantFromUrl = (rawUrl: string): void => {
    if (boundGrantId !== null) {
      return
    }
    const grantId = parseDocPreviewUrl(rawUrl)?.grantId ?? null
    // Why the grant must still be live: registering under the page a dead grant names would put a
    // guest nothing can read into the registry the tool door answers from.
    const grant = grantId === null ? null : getDocPreviewGrant(grantId)
    if (!grant) {
      return
    }
    boundGrantId = grant.id
    boundPageId = grant.browserPageId
    docGuestsByPageId.set(boundPageId, { guest, hostId: host.id, grantId: grant.id })
    for (const listener of registrationListeners) {
      listener(boundPageId)
    }
  }

  previewGuests.set(guest, {
    host,
    readBoundGrantId: () => boundGrantId
  })
  const forgetGuest = (): void => {
    previewGuests.delete(guest)
    // Why the identity check: a re-mint registers the replacement under the same page before this
    // guest's own teardown runs, and deleting by key alone would unregister the live one.
    if (boundPageId !== null && docGuestsByPageId.get(boundPageId)?.guest === guest) {
      docGuestsByPageId.delete(boundPageId)
    }
  }
  guest.once('destroyed', forgetGuest)

  const isAllowedPreviewNavigation = (rawUrl: string): boolean => {
    const target = parseDocPreviewUrl(rawUrl)
    if (!target || !getDocPreviewGrant(target.grantId)) {
      return false
    }
    // Why the latch is required and not just consistent: the renderer-set src is browser-initiated,
    // so will-navigate never fires for it. Anything reaching here before the latch is the guest
    // moving itself, which no grant has admitted yet.
    return boundGrantId !== null && target.grantId === boundGrantId
  }

  /**
   * Why deny-only, with nothing routed: a navigation the guest starts cannot be attributed to the
   * reader. The document may read its whole grant over `connect-src 'self'`, so routing an
   * unattributable URL to a real browser tab with full network is how those bytes would get out.
   */
  const navigationGuard = (event: Electron.Event, url: string): void => {
    if (isAllowedPreviewNavigation(url)) {
      return
    }
    event.preventDefault()
  }

  // Why here and not only on navigation events: the guest is already loading its src by the time
  // the embedder hands it to us, so the only navigation most previews ever make has already
  // started. Latching what it is on now is what binds the usual preview to its grant at all.
  latchGrantFromUrl(guest.getURL())
  const latchFromMainFrameNavigation = (details: { isMainFrame: boolean; url: string }): void => {
    // Why: only the top document defines which grant this guest belongs to. Latching from a
    // subframe would let an in-document iframe rebind the guest to another grant.
    if (!details.isMainFrame) {
      return
    }
    latchGrantFromUrl(details.url)
  }
  // Why a committed URL too: a navigation that started before this listener existed still commits
  // after it, and a preview that never navigates again would otherwise stay bound to nothing.
  const latchFromCommittedUrl = (_event: Electron.Event, url: string): void =>
    latchGrantFromUrl(url)
  // Why: will-navigate never fires for a subframe, so without this an <iframe src="https://…">
  // inside a previewed document would load off-machine even though the top frame cannot.
  const frameNavigationGuard = (details: {
    isMainFrame: boolean
    url: string
    preventDefault: () => void
  }): void => {
    if (details.isMainFrame || isAllowedPreviewNavigation(details.url)) {
      return
    }
    details.preventDefault()
  }
  guest.on('did-start-navigation', latchFromMainFrameNavigation)
  guest.on('did-navigate', latchFromCommittedUrl)
  guest.on('will-navigate', navigationGuard)
  guest.on('will-redirect', navigationGuard)
  guest.on('will-frame-navigate', frameNavigationGuard)
  // Why deny with nothing routed: previews own no native child windows, and a popup the document
  // asked for is the document asking, not the reader. A link the reader presses is intercepted
  // before Chromium ever considers a popup.
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Why a second fence for one API: WebRTC opens UDP straight from the network stack, so neither the
  // response CSP nor the session's request filter ever sees it. This is the only layer that can.
  enforceBrowserRouteWebRtcPolicy(guest, () => {})

  return () => {
    forgetGuest()
    if (guest.isDestroyed()) {
      return
    }
    guest.off('destroyed', forgetGuest)
    guest.off('did-start-navigation', latchFromMainFrameNavigation)
    guest.off('did-navigate', latchFromCommittedUrl)
    guest.off('will-navigate', navigationGuard)
    guest.off('will-redirect', navigationGuard)
    guest.off('will-frame-navigate', frameNavigationGuard)
  }
}

function isWebUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * The only way a URL leaves a preview. Every condition is load-bearing: the isolated preload must
 * report a trusted anchor click, the sender must be a live preview guest still bound to a grant,
 * and the target must be the web. Anything else is dropped without a trace the document can observe.
 */
export function reportDocPreviewLinkClick(sender: Electron.WebContents, rawUrl: string): void {
  const registration = previewGuests.get(sender)
  if (!registration) {
    return
  }
  const boundGrantId = registration.readBoundGrantId()
  if (boundGrantId === null || !getDocPreviewGrant(boundGrantId)) {
    return
  }
  const externalUrl = normalizeExternalBrowserUrl(rawUrl)
  if (!externalUrl || !isWebUrl(externalUrl)) {
    return
  }
  registration.host.send(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, { url: externalUrl })
}
