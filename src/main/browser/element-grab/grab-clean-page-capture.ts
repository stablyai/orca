import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-types'

const GRAB_PAINT_WORLD_ID = 1_209
const GUEST_PAINT_DEADLINE_MS = 500
const TWO_FRAMES_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/** Watches for anything that retires the document a capture began on: navigation (including same-URL reloads) or teardown. */
function watchDocument(guest: Electron.WebContents): { retired: () => boolean; stop: () => void } {
  let retired = guest.isDestroyed()
  const onNavigation = (
    _event: unknown,
    _url: unknown,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && !isInPlace) {
      retired = true
    }
  }
  const onDestroyed = (): void => {
    retired = true
  }
  guest.on('did-start-navigation', onNavigation)
  guest.on('destroyed', onDestroyed)
  return {
    retired: () => retired,
    stop: () => {
      guest.off('did-start-navigation', onNavigation)
      guest.off('destroyed', onDestroyed)
    }
  }
}

/**
 * Draw's page image, taken only after the picker's teardown ran and the page painted two frames without it.
 * Callers run this inside the page's serialized grab mode queue, so no arm from any viewer lands in between.
 */
export async function captureCleanGuestPage({
  guest,
  resolveGuest,
  teardown,
  holdPaint
}: {
  guest: Electron.WebContents
  /** The guest the caller may still capture; null or another guest once its viewer is retired. */
  resolveGuest: () => Electron.WebContents | null
  teardown: () => Promise<boolean>
  holdPaint: () => () => void
}): Promise<BrowserCleanPageCapture | null> {
  const document = watchDocument(guest)
  const isLive = (): boolean => !document.retired() && resolveGuest() === guest
  const releasePaint = holdPaint()
  try {
    if (!(await teardown()) || !isLive()) {
      return null
    }
    const painted = await withTimeout(
      guest.executeJavaScriptInIsolatedWorld(GRAB_PAINT_WORLD_ID, [{ code: TWO_FRAMES_SCRIPT }]),
      GUEST_PAINT_DEADLINE_MS,
      false
    )
    if (painted !== true || !isLive()) {
      return null
    }
    const image = await guest.capturePage()
    if (image.isEmpty() || !isLive()) {
      return null
    }
    return { dataUrl: image.toDataURL(), ...image.getSize() }
  } catch {
    return null
  } finally {
    releasePaint()
    document.stop()
  }
}
