import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-clean-capture'

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
// One native readback per guest: an abandoned one still occupies its slot until Electron settles it.
const reading = new WeakSet<ReadbackGuest>()

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
 * in flight. The paint lease lives as long as the readback itself (capped), because releasing it
 * schedules a visibility-restore capture that must not overlap this one. A cancelled capture's late
 * bytes are dropped, never handed to Draw.
 */
export async function captureCleanGuestPage(
  guest: ReadbackGuest,
  signal: AbortSignal,
  holdPaint: () => () => void,
  deadlineMs = CLEAN_CAPTURE_DEADLINE_MS,
  paintCapMs = ABANDONED_READBACK_PAINT_CAP_MS
): Promise<BrowserCleanPageCapture | null> {
  if (signal.aborted || guest.isDestroyed() || reading.has(guest)) {
    return null
  }
  let releasePaint: () => void
  try {
    releasePaint = once(holdPaint())
  } catch {
    // No lease and no readback: nothing holds the guest's slot, so the next Draw can try again.
    return null
  }
  let physical: Promise<ReadbackImage | null>
  try {
    physical = guest.capturePage().catch(() => null)
  } catch {
    releasePaint()
    return null
  }
  reading.add(guest)
  let paintCap: ReturnType<typeof setTimeout> | undefined
  let settled = false
  void physical.then(() => {
    settled = true
    clearTimeout(paintCap)
    reading.delete(guest)
    releasePaint()
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  const image = await Promise.race([
    physical,
    new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), deadlineMs)
    })
  ])
  clearTimeout(deadline)
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
