import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-clean-capture'

type ReadbackImage = {
  isEmpty: () => boolean
  toDataURL: () => string
  getSize: () => { width: number; height: number }
}
type ReadbackGuest = { isDestroyed: () => boolean; capturePage: () => Promise<ReadbackImage> }

/** Matches the renderer's former capture deadline, so a lost native completion cannot hold Draw. */
export const CLEAN_CAPTURE_DEADLINE_MS = 10_000
// One native readback per guest: an abandoned one still occupies its slot until Electron settles it.
const reading = new WeakSet<ReadbackGuest>()

/**
 * Cancellation does not end the wait. Paint and the caller's admission stay held until Electron
 * settles the readback or the deadline abandons it, so no successor arm or capture starts while
 * native work is still in flight. A cancelled capture's late bytes are dropped, never handed to Draw.
 */
export async function captureCleanGuestPage(
  guest: ReadbackGuest,
  signal: AbortSignal,
  holdPaint: () => () => void,
  deadlineMs = CLEAN_CAPTURE_DEADLINE_MS
): Promise<BrowserCleanPageCapture | null> {
  if (signal.aborted || guest.isDestroyed() || reading.has(guest)) {
    return null
  }
  reading.add(guest)
  const releasePaint = holdPaint()
  let physical: Promise<ReadbackImage | null> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    physical = guest.capturePage().catch(() => null)
    const image = await Promise.race([
      physical,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deadlineMs)
      })
    ])
    if (!image || image.isEmpty() || signal.aborted || guest.isDestroyed()) {
      return null
    }
    return { dataUrl: image.toDataURL(), ...image.getSize() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    releasePaint()
    if (physical) {
      void physical.finally(() => reading.delete(guest))
    } else {
      reading.delete(guest)
    }
  }
}
