import { randomUUID } from 'node:crypto'
import {
  installBrowserGuestHistoryProvenance,
  type BrowserGuestHistoryProtection
} from './browser-guest-history-provenance'
import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT,
  type BrowserGuestDiscardProtection
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

type ProtectionOwner = BrowserGuestHistoryProtection & {
  generation: string | null
  unavailable: boolean
}
const initialGuests = new WeakSet<Electron.WebContents>()
export function markInitialBrowserGuest(guest: Electron.WebContents): void {
  initialGuests.add(guest)
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
  if (owner.mediaGranted) {
    return result('protected', 'capture')
  }
  if (owner.historyEdits || owner.historyMethodUnknown || !owner.knownGet) {
    return result('protected', 'history')
  }
  return result('discardable', 'clean')
}

export function installBrowserGuestDiscardProtection(
  guest: Electron.WebContents,
  changed: () => void,
  initial = initialGuests.has(guest)
): () => void {
  const owner: ProtectionOwner = {
    generation: null,
    dirty: null,
    unavailable: false,
    navigating: false,
    currentEdited: false,
    coverageUnknown: !initial,
    documentSeen: !initial,
    knownGet: false,
    historyEdits: !initial,
    historyMethodUnknown: !initial,
    mediaGranted: false,
    episode: null
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
  const rederiveSoleHistory = (): void => {
    // Only a proved sole clean GET can retire earlier, now absent obligations.
    if (owner.dirty === false && owner.knownGet && !owner.unavailable && !owner.coverageUnknown) {
      try {
        if (
          guest.navigationHistory.length() === 1 &&
          guest.navigationHistory.getActiveIndex() === 0
        ) {
          owner.historyEdits = false
          owner.historyMethodUnknown = false
        }
      } catch {
        owner.historyMethodUnknown = true
      }
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
      owner.historyEdits = true
      owner.currentEdited = true
    }
    owner.dirty = owner.currentEdited || payload.dirty
    rederiveSoleHistory()
    publish()
  }
  const stopHistory = installBrowserGuestHistoryProvenance(
    guest,
    owner,
    publish,
    invalidate,
    rederiveSoleHistory
  )
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
    owner.historyEdits = true
    owner.coverageUnknown = true
    invalidate()
  }
  const responsive = (): void => {
    owner.unavailable = false
    snapshot()
  }
  const frameCreated = (): void => {
    owner.coverageUnknown = true
    publish()
  }
  const audioChanged = (): void => publish()
  const inPageNavigation = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) {
      publish()
    }
  }
  guest.on('ipc-message', report)
  guest.on('dom-ready', settled)
  guest.on('did-stop-loading', loadStopped)
  guest.on('responsive', responsive)
  guest.on('unresponsive', unresponsive)
  guest.on('render-process-gone', unresponsive)
  guest.on('frame-created', frameCreated)
  guest.on('audio-state-changed', audioChanged)
  guest.on('did-navigate-in-page', inPageNavigation)
  return () => {
    stopHistory()
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
    guest.off('audio-state-changed', audioChanged)
    guest.off('did-navigate-in-page', inPageNavigation)
  }
}

export function protectBrowserGuestMedia(guest: Electron.WebContents): void {
  const owner = owners.get(guest)
  if (owner) {
    owner.mediaGranted = true
  }
}
