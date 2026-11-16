import {
  installBrowserGuestIdleProtection,
  readBrowserGuestIdleProtection
} from './browser-guest-idle-protection'
export {
  setBrowserGuestSemanticVisibility,
  registerBrowserSessionNotificationGrant
} from './browser-guest-idle-protection'
import { randomUUID } from 'node:crypto'
import { observeBrowserGuestRequests } from '../../../sessions/requests/browser-session-web-request-observer'
import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT,
  type BrowserGuestDiscardProtection
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

type ProtectionOwner = {
  generation: string | null
  dirty: boolean | null
  navigating: boolean
  currentEdited: boolean
  currentPost: boolean
  mediaGranted: boolean
  unavailable: boolean
  // Null until the private observer reports them for the current challenge.
  pictureInPicture: boolean | null
  pdf: boolean | null
  changed: () => void
}
const owners = new WeakMap<Electron.WebContents, ProtectionOwner>()
export function invalidateBrowserGuestDiscardProtection(guest: Electron.WebContents): void {
  try {
    owners.get(guest)?.changed()
  } catch {
    // A disposed recipient must not fail a debugger acquisition.
  }
}

export function readBrowserGuestDiscardProtection(
  guest: Electron.WebContents
): BrowserGuestDiscardProtection {
  const result = (
    protection: BrowserGuestDiscardProtection['protection'],
    reason: BrowserGuestDiscardProtection['reason']
  ): BrowserGuestDiscardProtection => ({ webContentsId: guest.id, protection, reason })
  if (guest.isDestroyed() || guest.isCrashed()) {
    return result('gone', 'gone')
  }
  const owner = owners.get(guest)
  if (!owner || owner.unavailable || owner.navigating || owner.dirty === null) {
    return result('unknown', 'observer')
  }
  // Input does not bubble out of child frames; retain their unobserved drafts conservatively.
  if (guest.mainFrame.frames.length > 0) {
    return result('unknown', 'frames')
  }
  if (owner.dirty) {
    return result('protected', 'edits')
  }
  // Restore reloads a POST entry as a plain GET, so reopening a POST result would show another page.
  if (owner.currentPost) {
    return result('protected', 'post')
  }
  if (owner.pictureInPicture === null || owner.pdf === null) {
    return result('unknown', 'observer')
  }
  if (owner.pictureInPicture) {
    return result('protected', 'picture-in-picture')
  }
  if (owner.pdf) {
    return result('protected', 'pdf')
  }
  if (guest.isCurrentlyAudible()) {
    return result('protected', 'audio')
  }
  if (owner.mediaGranted) {
    return result('protected', 'capture')
  }
  try {
    // Only web and data pages can be freed; files and workspace documents stay.
    if (!/^(https?|data):/i.test(guest.getURL())) {
      return result('protected', 'url')
    }
  } catch {
    return result('unknown', 'observer')
  }
  return result('discardable', 'clean')
}

export function readBrowserGuestDiscardAdmission(
  guest: Electron.WebContents,
  proactive: boolean
): BrowserGuestDiscardProtection {
  return readBrowserGuestIdleProtection(guest, readBrowserGuestDiscardProtection(guest), proactive)
}

export function installBrowserGuestDiscardProtection(
  guest: Electron.WebContents,
  changed: () => void
): () => void {
  const owner: ProtectionOwner = {
    changed,
    generation: null,
    dirty: null,
    unavailable: false,
    navigating: false,
    currentEdited: false,
    currentPost: false,
    mediaGranted: false,
    pictureInPicture: null,
    pdf: null
  }
  owners.set(guest, owner)
  let published: BrowserGuestDiscardProtection | undefined
  const publish = (invalidateDocument = false): void => {
    const next = readBrowserGuestDiscardProtection(guest)
    if (
      !invalidateDocument &&
      published?.protection === next.protection &&
      published.reason === next.reason
    ) {
      return
    }
    published = next
    changed()
  }
  const invalidate = (): void => {
    owner.generation = null
    owner.dirty = null
    owner.pictureInPicture = null
    owner.pdf = null
    publish(true)
  }
  const snapshot = (): void => {
    if (guest.isDestroyed() || guest.isCrashed() || owner.navigating || owner.unavailable) {
      return
    }
    owner.generation = randomUUID()
    owner.dirty = null
    owner.pictureInPicture = null
    owner.pdf = null
    publish(true)
    try {
      guest.mainFrame.send(BROWSER_GUEST_PROTECTION_CHALLENGE, owner.generation)
    } catch {
      // Missing observers stay protected until a real readiness event rebinds them.
    }
  }
  const report = (event: Electron.IpcMainEvent, channel: string, payload: unknown): void => {
    if (
      channel !== BROWSER_GUEST_PROTECTION_REPORT ||
      guest.isDestroyed() ||
      event.sender !== guest ||
      event.senderFrame !== guest.mainFrame ||
      !payload ||
      typeof payload !== 'object'
    ) {
      return
    }
    if ('ready' in payload && payload.ready === true) {
      snapshot()
      return
    }
    if (
      owner.navigating ||
      owner.unavailable ||
      !owner.generation ||
      !('generation' in payload) ||
      payload.generation !== owner.generation ||
      !('dirty' in payload) ||
      typeof payload.dirty !== 'boolean'
    ) {
      return
    }
    if (payload.dirty) {
      owner.currentEdited = true
    }
    owner.dirty = owner.currentEdited || payload.dirty
    // An observer that omits a field cannot prove its document safe.
    owner.pictureInPicture =
      'pictureInPicture' in payload && typeof payload.pictureInPicture === 'boolean'
        ? payload.pictureInPicture
        : null
    owner.pdf =
      'contentType' in payload && typeof payload.contentType === 'string'
        ? payload.contentType === 'application/pdf'
        : null
    publish()
  }
  // Only the current document protects; restored back/forward entries reload on demand.
  let pendingMethod: string | null = null
  const stopRequests = observeBrowserGuestRequests(guest.id, (session, event, details) => {
    if (
      event === 'onBeforeRequest' &&
      details.resourceType === 'mainFrame' &&
      session === guest.session
    ) {
      pendingMethod = details.method
    }
  })
  const navigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      pendingMethod = null
      owner.navigating = true
      invalidate()
    } else if (!details.isMainFrame) {
      publish()
    }
  }
  const committed = (): void => {
    owner.currentEdited = false
    owner.currentPost = pendingMethod !== null && pendingMethod !== 'GET'
    owner.mediaGranted = false
    publish()
  }
  const settled = (): void => {
    owner.navigating = false
    owner.unavailable = false
    snapshot()
  }
  const loadStopped = (): void => {
    const needsSnapshot = owner.navigating || owner.generation === null
    owner.navigating = false
    if (needsSnapshot) {
      snapshot()
    } else {
      publish()
    }
  }
  const unresponsive = (): void => {
    owner.unavailable = true
    invalidate()
  }
  const responsive = (): void => {
    owner.unavailable = false
    snapshot()
  }
  const frameCreated = (): void => publish()
  const inPageNavigation = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) {
      publish()
    }
  }
  const stopIdleProtection = installBrowserGuestIdleProtection(guest, publish)
  guest.on('ipc-message', report)
  guest.on('dom-ready', settled)
  guest.on('did-stop-loading', loadStopped)
  guest.on('responsive', responsive)
  guest.on('unresponsive', unresponsive)
  guest.on('render-process-gone', unresponsive)
  guest.on('frame-created', frameCreated)
  guest.on('did-start-navigation', navigation)
  guest.on('did-navigate', committed)
  guest.on('did-navigate-in-page', inPageNavigation)
  return () => {
    stopRequests()
    stopIdleProtection()
    if (owners.get(guest) === owner) {
      owners.delete(guest)
    }
    guest.off('ipc-message', report)
    guest.off('dom-ready', settled)
    guest.off('did-stop-loading', loadStopped)
    guest.off('responsive', responsive)
    guest.off('unresponsive', unresponsive)
    guest.off('render-process-gone', unresponsive)
    guest.off('frame-created', frameCreated)
    guest.off('did-start-navigation', navigation)
    guest.off('did-navigate', committed)
    guest.off('did-navigate-in-page', inPageNavigation)
  }
}

export function protectBrowserGuestMedia(guest: Electron.WebContents): void {
  const owner = owners.get(guest)
  if (owner) {
    owner.mediaGranted = true
  }
}
