import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import type { BrowserSetGrabModeResult } from '../../../shared/browser/element-grab/browser-grab-types'

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
const grabModeOperationByPageId = new Map<string, Promise<void>>()

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
  grabModeIntentByPageId.clear()
  // Retired registrations must not leave chains blocking new operations.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
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
  const isCurrentIntent = (): boolean => grabModeIntentByPageId.get(browserPageId) === intent
  let guest = resolveGuest()
  if (!guest && enabled && waitForGuest) {
    await waitForGuest()
    if (!isCurrentIntent()) {
      return { ok: true }
    }
    guest = resolveGuest()
  }
  if (!guest) {
    return enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
  }
  return queueGrabModeOperation(browserPageId, async () => {
    if (!isCurrentIntent()) {
      return { ok: true }
    }
    const current = resolveGuest()
    if (!current) {
      return enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
    }
    const success = await browserManager.setGrabMode(browserPageId, enabled, current)
    if (!isCurrentIntent()) {
      return { ok: true }
    }
    return success ? { ok: true } : { ok: false, reason: 'injection-failed' }
  })
}
