import type { BrowserGrabRect, BrowserGrabScreenshot } from '../../shared/browser-grab-types'
import { GRAB_BUDGET } from '../../shared/browser-grab-types'

const HIDE_BROWSER_GRAB_OVERLAY_SCRIPT = `(function(){
  var g = window.__orcaGrab;
  if (g && g.host) g.host.style.display = 'none';
  document.querySelectorAll('[data-orca-browser-annotation-overlay]').forEach(function(el) {
    el.setAttribute('data-orca-previous-display', el.style.display || '');
    el.style.display = 'none';
  });
})()`

const RESTORE_BROWSER_GRAB_OVERLAY_SCRIPT = `(function(){
  var g = window.__orcaGrab;
  if (g && g.host) g.host.style.display = '';
  document.querySelectorAll('[data-orca-browser-annotation-overlay]').forEach(function(el) {
    el.style.display = el.getAttribute('data-orca-previous-display') || '';
    el.removeAttribute('data-orca-previous-display');
  });
})()`

/**
 * Capture a screenshot of the guest surface and optionally crop it to
 * the given CSS-pixel rect.
 */
export async function captureSelectionScreenshot(
  rect: BrowserGrabRect,
  guest: Electron.WebContents
): Promise<BrowserGrabScreenshot | null> {
  try {
    // Why: the rect comes from the renderer via IPC. Validate that all fields
    // are finite numbers before using them in arithmetic, so NaN cannot reach
    // Electron's image.crop() and cause undefined behavior.
    const safeN = (n: unknown, fallback = 0): number =>
      typeof n === 'number' && Number.isFinite(n) ? n : fallback
    const safeRect = {
      x: safeN(rect.x),
      y: safeN(rect.y),
      width: safeN(rect.width),
      height: safeN(rect.height)
    }

    // Why: hide the grab overlay before capturing so the highlight box and
    // label don't appear in the screenshot. The overlay is restored after.
    // Wrapped in try/finally so the overlay is always restored even if
    // capturePage() throws (e.g., guest destroyed mid-capture).
    await guest.executeJavaScript(HIDE_BROWSER_GRAB_OVERLAY_SCRIPT).catch(() => {})
    let image: Electron.NativeImage
    try {
      image = await guest.capturePage()
    } finally {
      await guest.executeJavaScript(RESTORE_BROWSER_GRAB_OVERLAY_SCRIPT).catch(() => {})
    }
    if (image.isEmpty()) {
      return null
    }

    const bitmapSize = image.getSize()
    // Why: capturePage returns a bitmap in physical pixels. The grab rect is
    // in CSS pixels. To map between them we need the combined scale factor
    // (zoomFactor * deviceScaleFactor). Rather than using the primary display
    // (which is wrong on multi-monitor setups with mixed DPI), we derive the
    // scale factor empirically: ask the guest for its CSS viewport width, then
    // compute scaleFactor = bitmapWidth / viewportCSSWidth. This is correct
    // regardless of which display the window is on.
    const viewportCSSWidth: number = await guest.executeJavaScript('window.innerWidth')
    if (!viewportCSSWidth || viewportCSSWidth <= 0) {
      return null
    }
    const scaleFactor = bitmapSize.width / viewportCSSWidth

    // Map CSS-pixel rect to bitmap coordinates
    const cropX = Math.max(0, Math.round(safeRect.x * scaleFactor))
    const cropY = Math.max(0, Math.round(safeRect.y * scaleFactor))
    const cropW = Math.min(bitmapSize.width - cropX, Math.round(safeRect.width * scaleFactor))
    const cropH = Math.min(bitmapSize.height - cropY, Math.round(safeRect.height * scaleFactor))

    if (cropW <= 0 || cropH <= 0) {
      return null
    }

    const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
    const pngBuffer = cropped.toPNG()

    // Why: downscaling would add complexity for v1. Fail closed to
    // "no screenshot" rather than send an oversized payload.
    if (pngBuffer.byteLength > GRAB_BUDGET.screenshotMaxBytes) {
      return null
    }

    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
    // Why: cropW/cropH are in physical pixels (bitmap coordinates) but the
    // rest of the grab payload uses CSS pixels. Divide by scaleFactor so the
    // screenshot dimensions are consistent with rectViewport/rectPage.
    return {
      mimeType: 'image/png',
      dataUrl,
      width: Math.round(cropW / scaleFactor),
      height: Math.round(cropH / scaleFactor)
    }
  } catch {
    // Why: screenshot capture can fail if the guest is being torn down
    // or the compositor surface is not available. Fail closed.
    return null
  }
}
