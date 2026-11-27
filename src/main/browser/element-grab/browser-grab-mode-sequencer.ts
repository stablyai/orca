import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import type {
  BrowserCleanPageCapture,
  BrowserSetGrabModeResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import { captureCleanGuestPage, watchGuestDocument } from './grab-clean-page-capture'

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
const grabModeOperationByPageId = new Map<string, Promise<void>>()
const intentChangeListenersByPageId = new Map<string, Set<() => void>>()
const SUPERSEDED: BrowserSetGrabModeResult = { ok: true, superseded: true }
// Bounds a clean capture from admission through its last stage, however long the queue ahead of it is.
const CLEAN_CAPTURE_LIFETIME_MS = 10_000
const cleanCaptureRetirementsByPageId = new Map<string, Set<() => void>>()

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
  grabModeIntentByPageId.clear()
  // Retired registrations must not leave chains blocking new operations.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  notifyIntentChange(browserPageId)
  retireCleanCaptures(browserPageId)
  cleanCaptureRetirementsByPageId.delete(browserPageId)
  grabModeIntentByPageId.delete(browserPageId)
  // Reused page IDs must not queue behind destroyed guests.
  grabModeOperationByPageId.delete(browserPageId)
}

function recordIntent(browserPageId: string, enabled: boolean): () => boolean {
  const intent = {
    generation: (grabModeIntentByPageId.get(browserPageId)?.generation ?? 0) + 1,
    enabled
  }
  grabModeIntentByPageId.set(browserPageId, intent)
  notifyIntentChange(browserPageId)
  return () => grabModeIntentByPageId.get(browserPageId) === intent
}

/**
 * Turns the picker off and captures the page in one queued step: a later arm from any viewer, local or streamed,
 * waits behind it, so the image can never include a picker armed after the teardown. The caller has already
 * authorized `guest` for the document the request began on; the attempt stays bound to both from admission, and
 * anything that ends it before its turn (retirement, its deadline, a navigation, a crash) settles it at once.
 */
export function captureCleanBrowserPage(
  browserPageId: string,
  guest: Electron.WebContents,
  resolveGuest: () => Electron.WebContents | null,
  deadlineMs: number
): { capture: Promise<BrowserCleanPageCapture | null>; retire: () => void } {
  let retired = false
  let started = false
  let settleUnstarted: (capture: null) => void = () => {}
  const unstarted = new Promise<null>((resolve) => (settleUnstarted = resolve))
  const retirements = cleanCaptureRetirementsByPageId.get(browserPageId) ?? new Set()
  const dispose = (): void => {
    clearTimeout(lifetime)
    document.stop()
    retirements.delete(retire)
    if (
      retirements.size === 0 &&
      cleanCaptureRetirementsByPageId.get(browserPageId) === retirements
    ) {
      cleanCaptureRetirementsByPageId.delete(browserPageId)
    }
  }
  const retire = (): void => {
    retired = true
    // An attempt still waiting its turn holds nothing physical, so it leaves now; a started one finishes its stage.
    if (!started) {
      dispose()
      settleUnstarted(null)
    }
  }
  const document = watchGuestDocument(guest, retire)
  cleanCaptureRetirementsByPageId.set(browserPageId, retirements)
  retirements.add(retire)
  const lifetime = setTimeout(
    retire,
    Math.max(0, Math.min(deadlineMs - Date.now(), CLEAN_CAPTURE_LIFETIME_MS))
  )
  lifetime.unref?.()
  recordIntent(browserPageId, false)
  const queued = queueGrabModeOperation(browserPageId, async () => {
    if (retired) {
      return null
    }
    started = true
    try {
      return await captureCleanGuestPage({
        guest,
        isLive: () => !retired && Date.now() < deadlineMs && resolveGuest() === guest,
        teardown: () => browserManager.setGrabMode(browserPageId, false, guest),
        holdPaint: () => browserManager.holdPaintForCapture(guest.id)
      })
    } catch {
      return null
    } finally {
      dispose()
    }
  })
  return { capture: Promise.race([queued, unstarted]), retire }
}

/** Arms or tears down a page's picker; the latest request wins, whoever hosts the viewer. */
export async function setBrowserGrabMode(
  browserPageId: string,
  enabled: boolean,
  resolveGuest: () => Electron.WebContents | null,
  waitForGuest?: () => Promise<void>
): Promise<BrowserSetGrabModeResult> {
  const isCurrentIntent = recordIntent(browserPageId, enabled)
  let guest = resolveGuest()
  if (!guest && enabled && waitForGuest) {
    await waitForGuest()
    if (!isCurrentIntent()) {
      return SUPERSEDED
    }
    guest = resolveGuest()
  }
  if (!guest) {
    return enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
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
    return success ? { ok: true } : { ok: false, reason: 'injection-failed' }
  })
}
