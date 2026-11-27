import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import {
  MAX_CLEAN_CAPTURE_DEADLINE_MS,
  type BrowserCleanPageCapture,
  type BrowserSetGrabModeResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import { captureCleanGuestPage, watchGuestDocument } from './grab-clean-page-capture'
import {
  grabCaptureNeedsPaintProof,
  markGrabPaintProven
} from '../guest-lifecycle/manager/grab/browser-manager-grab'

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
type GrabModeQueue = { entries: (() => Promise<void>)[]; draining: boolean }
const grabModeQueueByPageId = new Map<string, GrabModeQueue>()
const intentChangeListenersByPageId = new Map<string, Set<() => void>>()
const SUPERSEDED: BrowserSetGrabModeResult = { ok: true, superseded: true }
const cleanCaptureRetirementsByPageId = new Map<string, Set<() => void>>()

/** Pages with a load wait or clean capture still registered; none once they settle, even for a destroyed guest. */
export function pagesWithPendingGrabWaits(): string[] {
  return [...intentChangeListenersByPageId.keys(), ...cleanCaptureRetirementsByPageId.keys()]
}

/** Operations waiting behind a running one, across pages; a withdrawn one is no longer counted or retained. */
export function queuedGrabModeOperationCount(): number {
  let count = 0
  for (const queue of grabModeQueueByPageId.values()) {
    count += queue.entries.length
  }
  return count
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

async function drainGrabModeQueue(browserPageId: string, queue: GrabModeQueue): Promise<void> {
  queue.draining = true
  for (let run = queue.entries.shift(); run; run = queue.entries.shift()) {
    await run()
  }
  queue.draining = false
  if (grabModeQueueByPageId.get(browserPageId) === queue) {
    grabModeQueueByPageId.delete(browserPageId)
  }
}

/**
 * Runs a page's grab mode operations one at a time. `withdraw` takes an operation that has not started out of
 * the queue at once and settles it with `value`; once started, an operation keeps the page until it settles.
 */
function queueGrabModeOperation<T>(
  browserPageId: string,
  operation: () => Promise<T>
): { result: Promise<T>; withdraw: (value: T) => boolean } {
  const queue = grabModeQueueByPageId.get(browserPageId) ?? { entries: [], draining: false }
  grabModeQueueByPageId.set(browserPageId, queue)
  let settle: (value: T | Promise<T>) => void = () => {}
  const result = new Promise<T>((resolve) => (settle = resolve))
  const run = async (): Promise<void> => {
    const running = Promise.resolve().then(operation)
    settle(running)
    await running.catch(() => {})
  }
  queue.entries.push(run)
  if (!queue.draining) {
    void drainGrabModeQueue(browserPageId, queue)
  }
  const withdraw = (value: T): boolean => {
    const index = queue.entries.indexOf(run)
    if (index === -1) {
      return false
    }
    queue.entries.splice(index, 1)
    settle(value)
    return true
  }
  return { result, withdraw }
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
  // Retired registrations must not leave queues blocking new operations; detached queues still drain.
  grabModeQueueByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  notifyIntentChange(browserPageId)
  retireCleanCaptures(browserPageId)
  cleanCaptureRetirementsByPageId.delete(browserPageId)
  grabModeIntentByPageId.delete(browserPageId)
  // Reused page IDs must not queue behind destroyed guests.
  grabModeQueueByPageId.delete(browserPageId)
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
): { capture: Promise<BrowserCleanPageCapture | null>; retire: () => void } | null {
  // One sample, taken after the caller's checks and before anything registers: a request already due changes
  // nothing, and a far-future one gets the maximum. This cutoff then governs the lifetime and every later check.
  const now = Date.now()
  if (deadlineMs <= now) {
    return null
  }
  const cutoffMs = Math.min(deadlineMs, now + MAX_CLEAN_CAPTURE_DEADLINE_MS)
  let retired = false
  let withdraw: (capture: null) => boolean = () => false
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
    // An attempt still waiting its turn holds nothing physical, so it leaves the queue now; a started one
    // finishes the stage it issued.
    if (withdraw(null)) {
      dispose()
    }
  }
  const document = watchGuestDocument(guest, retire)
  cleanCaptureRetirementsByPageId.set(browserPageId, retirements)
  retirements.add(retire)
  const lifetime = setTimeout(retire, cutoffMs - now)
  lifetime.unref?.()
  recordIntent(browserPageId, false)
  const queued = queueGrabModeOperation(browserPageId, async () => {
    try {
      return await captureCleanGuestPage({
        guest,
        isLive: () => !retired && Date.now() < cutoffMs && resolveGuest() === guest,
        teardown: () => browserManager.setGrabMode(browserPageId, false, guest),
        holdPaint: () => browserManager.holdPaintForCapture(guest.id),
        paintProof: {
          needed: () => grabCaptureNeedsPaintProof(guest),
          proven: () => markGrabPaintProven(guest)
        }
      })
    } catch {
      return null
    } finally {
      dispose()
    }
  })
  withdraw = queued.withdraw
  return { capture: queued.result, retire }
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
  }).result
}
