import { webFrameMain } from 'electron'
import { errorMessage } from '../../../shared/error-message'

// Page-side zoom that makes the laid-out content span the viewport width; read with the page unzoomed.
const MEASURE_FIT_ZOOM = `() => {
    const root = document.documentElement
    const viewport = root.clientWidth
    let right = 0
    // Why: fixed-width layouts leave the viewport wider than their content, so scrollWidth alone cannot see them.
    for (const element of document.body ? document.body.querySelectorAll('*') : []) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.right > right) {
        right = rect.right
      }
    }
    right = Math.min(right + window.scrollX, root.scrollWidth)
    return viewport > 0 && right > 0 ? viewport / right : 1
  }`

/**
 * Page-side script that CSS-zooms the document so its laid-out content spans the viewport width.
 * Runs in the guest's main world; re-running replaces the previous install.
 */
export function browserPageFitWidthScript(enabled: boolean): string {
  return `(() => {
  const KEY = '__orcaFitWidth'
  window[KEY]?.stop()
  delete window[KEY]
  const root = document.documentElement
  // Why: scroll offsets scale with the zoom; read them before a zoom change clamps them.
  const zoomTo = (measure) => {
    const previous = Number.parseFloat(root.style.getPropertyValue('zoom')) || 1
    const { scrollX, scrollY } = window
    root.style.removeProperty('zoom')
    const zoom = measure()
    if (Math.abs(zoom - 1) >= 0.01) {
      root.style.setProperty('zoom', String(zoom))
    }
    window.scrollTo((scrollX * zoom) / previous, (scrollY * zoom) / previous)
  }
  if (!${enabled}) {
    zoomTo(() => 1)
    return
  }
  const measure = ${MEASURE_FIT_ZOOM}
  let frame = 0
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        zoomTo(measure)
      })
    }
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('load', schedule)
  document.addEventListener('visibilitychange', schedule)
  document.fonts?.ready.then(schedule)
  window[KEY] = {
    stop: () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('load', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }
  zoomTo(measure)
  // Why: a pane hidden while the menu closes measures zero width; the next painted frame has the real one.
  schedule()
})()`
}

/** Electron zoom level at which the page would fit its width, or null when it cannot be measured. */
export async function measureBrowserPageFitLevel(
  guest: Electron.WebContents
): Promise<number | null> {
  // Why: one synchronous task, so the page never paints unzoomed.
  const script = `(() => {
  const root = document.documentElement
  const zoom = root.style.getPropertyValue('zoom')
  root.style.removeProperty('zoom')
  const ratio = (${MEASURE_FIT_ZOOM})()
  if (zoom) {
    root.style.setProperty('zoom', zoom)
  }
  return ratio
})()`
  try {
    const ratio: unknown = await guest.mainFrame.executeJavaScript(script)
    return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0
      ? guest.getZoomLevel() + Math.log(ratio) / Math.log(1.2)
      : null
  } catch {
    return null
  }
}

// Chromium's built-in PDF viewer draws in its own extension frame, out of reach of the page's CSS zoom.
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'

function pdfViewerFitWidthScript(enabled: boolean): string {
  return `(() => {
  let tries = 0
  // Why: the viewer sets up its viewport and document size after the frame loads.
  const apply = () => {
    const viewport = document.querySelector('pdf-viewer')?.viewport_
    if (!viewport?.documentDimensions_) {
      if (++tries < 50) setTimeout(apply, 100)
      return
    }
    if (${enabled}) {
      viewport.setFittingType('fit-to-width')
    } else if (viewport.fittingType === 'fit-to-width') {
      viewport.fitToNone()
    }
  }
  apply()
})()`
}

function runFitScript(guestId: number, frame: Electron.WebFrameMain, script: string): void {
  // Why: WebContents.executeJavaScript waits for loading to stop, so a page with a stuck request never refits.
  frame.executeJavaScript(script).catch((error: unknown) => {
    console.warn('[browser-site-display] failed to fit the page width', {
      guestWebContentsId: guestId,
      error: errorMessage(error)
    })
  })
}

/** Fits the page, or the PDF in Chromium's viewer, to the guest's width; false undoes it. */
export function fitGuestPageWidth(guest: Electron.WebContents, enabled: boolean): void {
  runFitScript(guest.id, guest.mainFrame, browserPageFitWidthScript(enabled))
  for (const frame of guest.mainFrame.framesInSubtree) {
    if (frame.url.startsWith(PDF_VIEWER_ORIGIN)) {
      runFitScript(guest.id, frame, pdfViewerFitWidthScript(enabled))
    }
  }
}

/** The PDF viewer frame finishes loading after dom-ready, so it is fitted then. */
export function watchGuestPdfViewerFit(
  guest: Electron.WebContents,
  isFitWidth: () => boolean
): () => void {
  const onFrameLoad = (
    _event: Electron.Event,
    isMainFrame: boolean,
    processId: number,
    routingId: number
  ): void => {
    const frame = isMainFrame ? null : webFrameMain.fromId(processId, routingId)
    if (frame?.url.startsWith(PDF_VIEWER_ORIGIN) && isFitWidth()) {
      runFitScript(guest.id, frame, pdfViewerFitWidthScript(true))
    }
  }
  guest.on('did-frame-finish-load', onFrameLoad)
  return () => guest.off('did-frame-finish-load', onFrameLoad)
}
