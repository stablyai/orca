import { randomUUID } from 'node:crypto'
import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT,
  type BrowserGuestDiscardProtection
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

type ProtectionOwner = {
  generation: string | null
  dirty: boolean | null
  unavailable: boolean
  navigating: boolean
}
const owners = new WeakMap<Electron.WebContents, ProtectionOwner>()

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
  if (guest.isCurrentlyAudible()) {
    return result('protected', 'audio')
  }
  try {
    // URL recovery cannot restore earlier documents or their drafts.
    if (guest.navigationHistory.length() > 1) {
      return result('protected', 'history')
    }
  } catch {
    return result('unknown', 'observer')
  }
  return result('discardable', 'clean')
}

export function installBrowserGuestDiscardProtection(
  guest: Electron.WebContents,
  changed: () => void
): () => void {
  const owner: ProtectionOwner = {
    generation: null,
    dirty: null,
    unavailable: false,
    navigating: false
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
    publish(true)
  }
  const snapshot = (): void => {
    if (guest.isDestroyed() || guest.isCrashed() || owner.navigating || owner.unavailable) {
      return
    }
    owner.generation = randomUUID()
    owner.dirty = null
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
    if (owner.dirty !== payload.dirty) {
      owner.dirty = payload.dirty
      publish()
    }
  }
  const navigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      owner.navigating = true
      invalidate()
    } else if (!details.isMainFrame) {
      publish()
    }
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
  const frameCreated = (): void => {
    publish()
  }
  const audioChanged = (): void => publish()
  const inPageNavigation = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) {
      publish()
    }
  }
  guest.on('ipc-message', report)
  guest.on('did-start-navigation', navigation)
  guest.on('dom-ready', settled)
  guest.on('did-stop-loading', loadStopped)
  guest.on('responsive', responsive)
  guest.on('unresponsive', unresponsive)
  guest.on('render-process-gone', unresponsive)
  guest.on('frame-created', frameCreated)
  guest.on('audio-state-changed', audioChanged)
  guest.on('did-navigate-in-page', inPageNavigation)
  return () => {
    if (owners.get(guest) === owner) {
      owners.delete(guest)
    }
    guest.off('ipc-message', report)
    guest.off('did-start-navigation', navigation)
    guest.off('dom-ready', settled)
    guest.off('did-stop-loading', loadStopped)
    guest.off('responsive', responsive)
    guest.off('unresponsive', unresponsive)
    guest.off('render-process-gone', unresponsive)
    guest.off('frame-created', frameCreated)
    guest.off('audio-state-changed', audioChanged)
    guest.off('did-navigate-in-page', inPageNavigation)
  }
}
