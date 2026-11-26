import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import type { BrowserSetGrabModeResult } from '../../../shared/browser/element-grab/browser-grab-types'

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
const grabModeOperationByPageId = new Map<string, Promise<void>>()
const intentChangeListenersByPageId = new Map<string, Set<() => void>>()
const SUPERSEDED: BrowserSetGrabModeResult = { ok: true, superseded: true }

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
      guest.off('did-stop-loading', done)
      guest.off('destroyed', done)
      resolve()
    }
    listeners.add(done)
    guest.on('did-stop-loading', done)
    guest.on('destroyed', done)
  })
}

function queueGrabModeOperation(
  browserPageId: string,
  operation: () => Promise<BrowserSetGrabModeResult>
): Promise<BrowserSetGrabModeResult> {
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
  grabModeIntentByPageId.clear()
  // Retired registrations must not leave chains blocking new operations.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  notifyIntentChange(browserPageId)
  grabModeIntentByPageId.delete(browserPageId)
  // Reused page IDs must not queue behind destroyed guests.
  grabModeOperationByPageId.delete(browserPageId)
}

/** Arms or tears down a page's picker; the latest request wins, whoever hosts the viewer. */
export async function setBrowserGrabMode(
  browserPageId: string,
  enabled: boolean,
  resolveGuest: () => Electron.WebContents | null,
  waitForGuest?: () => Promise<void>
): Promise<BrowserSetGrabModeResult> {
  const intent = {
    generation: (grabModeIntentByPageId.get(browserPageId)?.generation ?? 0) + 1,
    enabled
  }
  grabModeIntentByPageId.set(browserPageId, intent)
  notifyIntentChange(browserPageId)
  const isCurrentIntent = (): boolean => grabModeIntentByPageId.get(browserPageId) === intent
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
  return queueGrabModeOperation(browserPageId, async () => {
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
