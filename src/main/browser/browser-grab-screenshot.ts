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

export async function captureSelectionScreenshot(
  rect: BrowserGrabRect,
  guest: Electron.WebContents
): Promise<BrowserGrabScreenshot | null> {
  try {
    // Normalize nonfinite IPC coordinates before passing them to image.crop().
    const safeN = (n: unknown, fallback = 0): number =>
      typeof n === 'number' && Number.isFinite(n) ? n : fallback
    const safeRect = {
      x: safeN(rect.x),
      y: safeN(rect.y),
      width: safeN(rect.width),
      height: safeN(rect.height)
    }

    // Hide selection overlays during capture and attempt restoration even if capture fails.
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
    // Derive bitmap/CSS scaling from this guest, avoiding primary-display DPI assumptions.
    const viewportCSSWidth: number = await guest.executeJavaScript('window.innerWidth')
    if (!viewportCSSWidth || viewportCSSWidth <= 0) {
      return null
    }
    const scaleFactor = bitmapSize.width / viewportCSSWidth

    const cropX = Math.max(0, Math.round(safeRect.x * scaleFactor))
    const cropY = Math.max(0, Math.round(safeRect.y * scaleFactor))
    const cropW = Math.min(bitmapSize.width - cropX, Math.round(safeRect.width * scaleFactor))
    const cropH = Math.min(bitmapSize.height - cropY, Math.round(safeRect.height * scaleFactor))

    if (cropW <= 0 || cropH <= 0) {
      return null
    }

    const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
    const pngBuffer = cropped.toPNG()

    if (pngBuffer.byteLength > GRAB_BUDGET.screenshotMaxBytes) {
      return null
    }

    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
    // Report CSS dimensions to match the selection rectangles.
    return {
      mimeType: 'image/png',
      dataUrl,
      width: Math.round(cropW / scaleFactor),
      height: Math.round(cropH / scaleFactor)
    }
  } catch {
    // The guest or compositor surface may disappear during capture.
    return null
  }
}
