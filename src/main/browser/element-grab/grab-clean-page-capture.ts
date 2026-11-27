import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-types'

const GRAB_PAINT_WORLD_ID = 1_209
const GUEST_PAINT_DEADLINE_MS = 500
// A stalled guest keeps at most one frame probe pending; while it is, the guest can't prove a fresh paint.
const pendingFrameProbes = new WeakSet<Electron.WebContents>()
const TWO_FRAMES_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/** Reports the end of the document a capture was admitted for: navigation (same-URL reloads too), a crash, or teardown. */
export function watchGuestDocument(
  guest: Electron.WebContents,
  onRetired: () => void
): { stop: () => void } {
  const onNavigation = (
    _event: unknown,
    _url: unknown,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && !isInPlace) {
      onRetired()
    }
  }
  const onGone = (): void => onRetired()
  guest.on('did-start-navigation', onNavigation)
  guest.on('render-process-gone', onGone)
  guest.on('destroyed', onGone)
  return {
    stop: () => {
      guest.off('did-start-navigation', onNavigation)
      guest.off('render-process-gone', onGone)
      guest.off('destroyed', onGone)
    }
  }
}

/**
 * Draw's page image, taken only after the picker's teardown ran and, if an overlay was shown, the page painted
 * two frames without it.
 * Each stage starts only while `isLive`; a stage already issued is awaited, so the caller's queue stays held.
 */
export async function captureCleanGuestPage({
  guest,
  isLive,
  teardown,
  holdPaint,
  paintProof
}: {
  guest: Electron.WebContents
  isLive: () => boolean
  teardown: () => Promise<boolean>
  holdPaint: () => () => void
  /** Only a guest whose overlay was (or may still be) shown owes a painted frame; others are captured directly. */
  paintProof: { needed: () => boolean; proven: () => void }
}): Promise<BrowserCleanPageCapture | null> {
  if (!isLive()) {
    return null
  }
  let releasePaint = (): void => {}
  try {
    releasePaint = holdPaint()
    if (!(await teardown()) || !isLive()) {
      return null
    }
    if (paintProof.needed()) {
      if (pendingFrameProbes.has(guest)) {
        return null
      }
      pendingFrameProbes.add(guest)
      const probe = guest
        .executeJavaScriptInIsolatedWorld(GRAB_PAINT_WORLD_ID, [{ code: TWO_FRAMES_SCRIPT }])
        .finally(() => pendingFrameProbes.delete(guest))
      const painted = await withTimeout(probe, GUEST_PAINT_DEADLINE_MS, false)
      if (painted !== true || !isLive()) {
        return null
      }
      paintProof.proven()
    }
    const image = await guest.capturePage()
    if (image.isEmpty() || !isLive()) {
      return null
    }
    const dataUrl = image.toDataURL()
    // Encoding a large page takes time; the attempt may have expired or been retired meanwhile.
    return isLive() ? { dataUrl, ...image.getSize() } : null
  } finally {
    releasePaint()
  }
}
