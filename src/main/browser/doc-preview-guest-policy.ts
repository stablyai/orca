import {
  DOC_PREVIEW_EXTERNAL_LINK_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

type PreviewHostRenderer = {
  id: number
  send: (channel: string, payload: { url: string }) => void
}

type PreviewGuestRegistration = {
  host: PreviewHostRenderer
  readBoundGrantId: () => string | null
}

// IPC click reports identify only a sender; bind it to a known preview and grant.
const previewGuests = new WeakMap<object, PreviewGuestRegistration>()

// Keep document guests out of browsing flows; getAuthorizedGuest is the shared tool entry point.
const docGuestsByPageId = new Map<
  string,
  { guest: Electron.WebContents; hostId: number; grantId: string }
>()

const registrationListeners = new Set<(browserPageId: string) => void>()

// Tool requests may arrive before guest attachment; notify their IPC waiters.
export function onWorkspaceDocGuestRegistered(
  listener: (browserPageId: string) => void
): () => void {
  registrationListeners.add(listener)
  return () => registrationListeners.delete(listener)
}

/** Returns a live document guest only to its hosting renderer. */
export function getWorkspaceDocPageGuest(
  browserPageId: string,
  senderWebContentsId: number
): Electron.WebContents | null {
  const registration = docGuestsByPageId.get(browserPageId)
  if (!registration || registration.hostId !== senderWebContentsId) {
    return null
  }
  // Grant revocation precedes guest teardown.
  if (!getDocPreviewGrant(registration.grantId)) {
    return null
  }
  if (registration.guest.isDestroyed()) {
    docGuestsByPageId.delete(browserPageId)
    return null
  }
  return registration.guest
}

export function isWorkspaceDocPageId(browserPageId: string): boolean {
  return docGuestsByPageId.has(browserPageId)
}

// Session events supply only WebContents; recover its bound grant id.
export function readDocPreviewGuestBoundGrantId(guest: Electron.WebContents): string | null {
  return previewGuests.get(guest)?.readBoundGrantId() ?? null
}

// Preview navigation stays within its grant; only trusted preload click reports may open web links.
export function installDocPreviewGuestPolicy(
  guest: Electron.WebContents,
  host: PreviewHostRenderer
): () => void {
  // Pin the guest to its first admitted grant.
  let boundGrantId: string | null = null
  let boundPageId: string | null = null

  const latchGrantFromUrl = (rawUrl: string): void => {
    if (boundGrantId !== null) {
      return
    }
    const grantId = parseDocPreviewUrl(rawUrl)?.grantId ?? null
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
    // A replacement can register under this page before the old guest's teardown runs.
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
    // Renderer-set src bypasses will-navigate; pre-latch navigations are guest-initiated.
    return boundGrantId !== null && target.grantId === boundGrantId
  }

  // Scripted navigation cannot prove a reader click and must not open a network-capable tab.
  const navigationGuard = (event: Electron.Event, url: string): void => {
    if (isAllowedPreviewNavigation(url)) {
      return
    }
    event.preventDefault()
  }

  // The initial src may already be loading when the embedder hands over the guest.
  latchGrantFromUrl(guest.getURL())
  const latchFromMainFrameNavigation = (details: { isMainFrame: boolean; url: string }): void => {
    // Subframes must not choose the guest's grant.
    if (!details.isMainFrame) {
      return
    }
    latchGrantFromUrl(details.url)
  }
  // Catch initial loads that started before listeners were installed.
  const latchFromCommittedUrl = (_event: Electron.Event, url: string): void =>
    latchGrantFromUrl(url)
  // will-navigate excludes subframes, so guard them separately.
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
  // Trusted link clicks are intercepted by preload; document-created popups remain denied.
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  // WebRTC UDP bypasses CSP and session request filters; enforce IP handling on the guest.
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

// Preload reports trusted anchor clicks; require a known sender, live grant and web URL.
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
