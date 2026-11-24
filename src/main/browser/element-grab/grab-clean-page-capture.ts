import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-clean-capture'
import {
  isNativeCaptureBusy,
  occupyNativeCaptureLane,
  whenNativeCaptureLaneFree
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
    releasePaint = holdPaint()
  } catch {
    return null
  }
  const image = await readbackThroughCaptureLane(
    guest,
    signal,
    releasePaint,
    deadlineMs,
    paintCapMs
  )
  try {
    if (!image || image.isEmpty() || signal.aborted || guest.isDestroyed()) {
      return null
    }
    return { dataUrl: image.toDataURL(), ...image.getSize() }
  } catch {
    return null
  }
}

/**
 * One native readback through the guest's capture lane, for every grab capture (Draw's page and a
 * selection's crop). The deadline covers both the wait for a capture already in flight and the
 * readback itself; a readback it abandons keeps the lane until Electron settles it. Takes ownership
 * of `releasePaint`: the lease is held until the readback settles, capped by `paintCapMs`.
 */
export async function readbackThroughCaptureLane<Image>(
  guest: { isDestroyed: () => boolean; capturePage: () => Promise<Image> },
  signal: AbortSignal,
  releasePaint: () => void,
  deadlineMs: number,
  paintCapMs = ABANDONED_READBACK_PAINT_CAP_MS
): Promise<Image | null> {
  const release = once(releasePaint)
  // The deadline also withdraws a pending lane wait, so repeated timed-out readbacks leave no registrations.
  let stopWaiting: () => void = () => {}
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => {
      stopWaiting()
      resolve(null)
    }, deadlineMs)
  })
  // Checking the lane, submitting and recording the readback happen in one synchronous step, so two
  // waiters woken together cannot both submit; a waiter that finds the lane taken registers again.
  // Wrapped, because resolving with the readback promise itself would wait for it to settle.
  const submitted = await new Promise<{ physical: Promise<Image | null> } | null>((resolve) => {
    const attempt = (): void => {
      if (isNativeCaptureBusy(guest)) {
        const cancel = whenNativeCaptureLaneFree(guest, attempt)
        stopWaiting = () => {
          cancel()
          resolve(null)
        }
        return
      }
      stopWaiting = () => {}
      if (signal.aborted || guest.isDestroyed()) {
        resolve(null)
        return
      }
      try {
        const physical = guest.capturePage().catch(() => null)
        occupyNativeCaptureLane(guest, physical)
        resolve({ physical })
      } catch {
        resolve(null)
      }
    }
    attempt()
  })
  if (!submitted) {
    clearTimeout(deadlineTimer)
    release()
    return null
  }
  const { physical } = submitted
  let paintCap: ReturnType<typeof setTimeout> | undefined
  let settled = false
  void physical.then(() => {
    settled = true
    clearTimeout(paintCap)
    release()
  })
  const image = await Promise.race([physical, deadline])
  clearTimeout(deadlineTimer)
  if (!settled) {
    paintCap = setTimeout(release, paintCapMs)
  }
  return image
}
