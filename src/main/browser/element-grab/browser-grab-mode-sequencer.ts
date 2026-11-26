import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import type {
  BrowserCleanPageCapture,
  BrowserSetGrabModeResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import { captureCleanGuestPage, watchGuestDocument } from './grab-clean-page-capture'

const grabModeIntentByPageId = new Map<
  string,
  { generation: number; enabled: boolean; waiting?: boolean }
>()
const grabModeOperationByPageId = new Map<string, Promise<void>>()
const intentChangeListenersByPageId = new Map<string, Set<() => void>>()
const SUPERSEDED: BrowserSetGrabModeResult = { ok: true, superseded: true }
// Bounds a clean capture from admission through its last stage, however long the queue ahead of it is.
const CLEAN_CAPTURE_LIFETIME_MS = 10_000
const cleanCaptureRetirementsByPageId = new Map<string, Set<() => void>>()
const armTokenByPageId = new Map<string, string>()
let armTokenCounter = 0

/** An await may start a pick only for the arm the latest successful enable minted; any newer request voids it. */
export function isCurrentGrabArm(browserPageId: string, armToken: string | undefined): boolean {
  return armToken !== undefined && armTokenByPageId.get(browserPageId) === armToken
}

/** Pages with a load wait or clean capture still registered; none once they settle, even for a destroyed guest. */
export function pagesWithPendingGrabWaits(): string[] {
  return [...intentChangeListenersByPageId.keys(), ...cleanCaptureRetirementsByPageId.keys()]
}

function retireCleanCaptures(browserPageId: string): void {
  for (const retire of cleanCaptureRetirementsByPageId.get(browserPageId) ?? []) {
    retire()
  }
}

function notifyIntentChange(browserPageId: string): void {
  const listeners = intentChangeListenersByPageId.get(browserPageId)
  intentChangeListenersByPageId.delete(browserPageId)
  for (const listener of listeners ?? []) {
    listener()
  }
}

// Electron holds scripts until the main frame loads; waiting here instead lets a newer request skip this arm.
function waitUntilArmable(browserPageId: string, guest: Electron.WebContents): Promise<void> {
  if (guest.isDestroyed() || !guest.isLoadingMainFrame()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const listeners = intentChangeListenersByPageId.get(browserPageId) ?? new Set()
    intentChangeListenersByPageId.set(browserPageId, listeners)
    const done = (): void => {
      listeners.delete(done)
      if (listeners.size === 0 && intentChangeListenersByPageId.get(browserPageId) === listeners) {
        intentChangeListenersByPageId.delete(browserPageId)
      }
      guest.off('did-stop-loading', done)
      guest.off('destroyed', done)
      resolve()
    }
    listeners.add(done)
    guest.on('did-stop-loading', done)
    guest.on('destroyed', done)
  })
}

function queueGrabModeOperation<T>(browserPageId: string, operation: () => Promise<T>): Promise<T> {
  const previous = grabModeOperationByPageId.get(browserPageId) ?? Promise.resolve()
  const result = previous.then(operation)
  const completion = result.then(
    () => {},
    () => {}
  )
  grabModeOperationByPageId.set(browserPageId, completion)
  return result.finally(() => {
    if (grabModeOperationByPageId.get(browserPageId) === completion) {
      grabModeOperationByPageId.delete(browserPageId)
    }
  })
}

export function resetGrabModeState(): void {
  for (const browserPageId of intentChangeListenersByPageId.keys()) {
    notifyIntentChange(browserPageId)
  }
  for (const browserPageId of cleanCaptureRetirementsByPageId.keys()) {
    retireCleanCaptures(browserPageId)
  }
  cleanCaptureRetirementsByPageId.clear()
  armTokenByPageId.clear()
  grabModeIntentByPageId.clear()
  // Retired registrations must not leave chains blocking new operations.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  notifyIntentChange(browserPageId)
  retireCleanCaptures(browserPageId)
  cleanCaptureRetirementsByPageId.delete(browserPageId)
  armTokenByPageId.delete(browserPageId)
  grabModeIntentByPageId.delete(browserPageId)
  // Reused page IDs must not queue behind destroyed guests.
  grabModeOperationByPageId.delete(browserPageId)
}

function recordIntent(browserPageId: string, enabled: boolean, waiting = false): () => boolean {
  const intent = {
    generation: (grabModeIntentByPageId.get(browserPageId)?.generation ?? 0) + 1,
    enabled,
    waiting
  }
  grabModeIntentByPageId.set(browserPageId, intent)
  armTokenByPageId.delete(browserPageId)
  notifyIntentChange(browserPageId)
  return () => grabModeIntentByPageId.get(browserPageId) === intent
}

/**
 * Turns the picker off and captures the page in one queued step: a later arm from any viewer, local or streamed,
 * waits behind it, so the image can never include a picker armed after the teardown. The caller has already
 * authorized `guest`; the attempt stays bound to it and its document from admission, including while queued.
 */
export function captureCleanBrowserPage(
  browserPageId: string,
  guest: Electron.WebContents,
  resolveGuest: () => Electron.WebContents | null
): { capture: Promise<BrowserCleanPageCapture | null>; retire: () => void } {
  const document = watchGuestDocument(guest)
  let retired = false
  const retire = (): void => {
    retired = true
  }
  const retirements = cleanCaptureRetirementsByPageId.get(browserPageId) ?? new Set()
  cleanCaptureRetirementsByPageId.set(browserPageId, retirements)
  retirements.add(retire)
  const lifetime = setTimeout(retire, CLEAN_CAPTURE_LIFETIME_MS)
  lifetime.unref?.()
  recordIntent(browserPageId, false)
  const capture = queueGrabModeOperation(browserPageId, async () => {
    try {
      return await captureCleanGuestPage({
        guest,
        isLive: () => !retired && !document.retired() && resolveGuest() === guest,
        teardown: () => browserManager.setGrabMode(browserPageId, false, guest),
        holdPaint: () => browserManager.holdPaintForCapture(guest.id)
      })
    } catch {
      return null
    } finally {
      clearTimeout(lifetime)
      retirements.delete(retire)
      if (
        retirements.size === 0 &&
        cleanCaptureRetirementsByPageId.get(browserPageId) === retirements
      ) {
        cleanCaptureRetirementsByPageId.delete(browserPageId)
      }
      document.stop()
    }
  })
  return { capture, retire }
}

/** Arms or tears down a page's picker; the latest request wins, whoever hosts the viewer. */
export async function setBrowserGrabMode(
  browserPageId: string,
  enabled: boolean,
  resolveGuest: () => Electron.WebContents | null,
  waitForGuest?: () => Promise<void>
): Promise<BrowserSetGrabModeResult> {
  let guest = resolveGuest()
  if (!guest && !(enabled && waitForGuest)) {
    // A caller with no page it may drive changes nothing, except withdrawing an enable still awaiting registration.
    if (!enabled && grabModeIntentByPageId.get(browserPageId)?.waiting) {
      recordIntent(browserPageId, false)
    }
    return enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
  }
  const isCurrentIntent = recordIntent(browserPageId, enabled, !guest)
  if (!guest && waitForGuest) {
    await waitForGuest()
    if (!isCurrentIntent()) {
      return SUPERSEDED
    }
    guest = resolveGuest()
  }
  if (!guest) {
    return { ok: false, reason: 'not-ready' }
  }
  return queueGrabModeOperation<BrowserSetGrabModeResult>(browserPageId, async () => {
    if (!isCurrentIntent()) {
      return SUPERSEDED
    }
    let current = resolveGuest()
    if (current && enabled) {
      await waitUntilArmable(browserPageId, current)
      if (!isCurrentIntent()) {
        return SUPERSEDED
      }
      current = resolveGuest()
    }
    if (!current) {
      return enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
    }
    const success = await browserManager.setGrabMode(browserPageId, enabled, current)
    if (!isCurrentIntent()) {
      return SUPERSEDED
    }
    if (!success) {
      return { ok: false, reason: 'injection-failed' }
    }
    if (!enabled) {
      return { ok: true }
    }
    const armToken = `arm-${++armTokenCounter}`
    armTokenByPageId.set(browserPageId, armToken)
    return { ok: true, armToken }
  })
}
