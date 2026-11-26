import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-types'

const GRAB_PAINT_WORLD_ID = 1_209
const GUEST_PAINT_DEADLINE_MS = 500
const TWO_FRAMES_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/** Flags the end of the document a capture was admitted for: navigation (same-URL reloads too), a crash, or teardown. */
export function watchGuestDocument(guest: Electron.WebContents): {
  retired: () => boolean
  stop: () => void
} {
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
  const onGone = (): void => {
    retired = true
  }
  guest.on('did-start-navigation', onNavigation)
  guest.on('render-process-gone', onGone)
  guest.on('destroyed', onGone)
  return {
    retired: () => retired,
    stop: () => {
      guest.off('did-start-navigation', onNavigation)
      guest.off('render-process-gone', onGone)
      guest.off('destroyed', onGone)
    }
  }
}

/**
 * Draw's page image, taken only after the picker's teardown ran and the page painted two frames without it.
 * Each stage starts only while `isLive`; a stage already issued is awaited, so the caller's queue stays held.
 */
export async function captureCleanGuestPage({
  guest,
  isLive,
  teardown,
  holdPaint
}: {
  guest: Electron.WebContents
  isLive: () => boolean
  teardown: () => Promise<boolean>
  holdPaint: () => () => void
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
  } finally {
    releasePaint()
  }
}
