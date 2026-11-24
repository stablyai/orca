import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-clean-capture'
import {
  occupyNativeCaptureLane,
  pendingNativeCapture
} from '../../window/visibility/native-capture-lane'

type ReadbackImage = {
  isEmpty: () => boolean
  toDataURL: () => string
  getSize: () => { width: number; height: number }
}
type ReadbackGuest = { isDestroyed: () => boolean; capturePage: () => Promise<ReadbackImage> }

/** Matches the renderer's former capture deadline, so a lost native completion cannot hold Draw. */
export const CLEAN_CAPTURE_DEADLINE_MS = 10_000
/** Bounds how long an abandoned readback keeps the guest unthrottled if Electron never settles it. */
export const ABANDONED_READBACK_PAINT_CAP_MS = 60_000

function once(run: () => void): () => void {
  let done = false
  return () => {
    if (!done) {
      done = true
      run()
    }
  }
}

/**
 * Cancellation does not end the wait. The caller's admission stays held until Electron settles the
 * readback or the deadline abandons it, so no successor arm or capture starts while native work is
 * in flight. The guest's native capture lane is shared with the paint lease's visibility restore:
 * Draw waits (within its deadline) for a capture already in flight, and its own readback keeps the
 * restore from submitting until it settles. A cancelled capture's late bytes are dropped.
 */
export async function captureCleanGuestPage(
  guest: ReadbackGuest,
  signal: AbortSignal,
  holdPaint: () => () => void,
  deadlineMs = CLEAN_CAPTURE_DEADLINE_MS,
  paintCapMs = ABANDONED_READBACK_PAINT_CAP_MS
): Promise<BrowserCleanPageCapture | null> {
  if (signal.aborted || guest.isDestroyed()) {
    return null
  }
  let releasePaint: () => void
  try {
    // Taking the lease first cancels a restore that has not been submitted yet.
    releasePaint = once(holdPaint())
  } catch {
    return null
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), deadlineMs)
  })
  for (let busy = pendingNativeCapture(guest); busy; busy = pendingNativeCapture(guest)) {
    if ((await Promise.race([busy.then(() => true), deadline])) !== true) {
      releasePaint()
      return null
    }
  }
  if (signal.aborted || guest.isDestroyed()) {
    clearTimeout(deadlineTimer)
    releasePaint()
    return null
  }
  let physical: Promise<ReadbackImage | null>
  try {
    physical = guest.capturePage().catch(() => null)
  } catch {
    clearTimeout(deadlineTimer)
    releasePaint()
    return null
  }
  occupyNativeCaptureLane(guest, physical)
  let paintCap: ReturnType<typeof setTimeout> | undefined
  let settled = false
  void physical.then(() => {
    settled = true
    clearTimeout(paintCap)
    releasePaint()
  })
  const image = await Promise.race([physical, deadline])
  clearTimeout(deadlineTimer)
  if (!settled) {
    paintCap = setTimeout(releasePaint, paintCapMs)
  }
  try {
    if (!image || image.isEmpty() || signal.aborted || guest.isDestroyed()) {
      return null
    }
    return { dataUrl: image.toDataURL(), ...image.getSize() }
  } catch {
    return null
  }
}
