import type { WebContents } from 'electron'
import type { BrowserScreencastFrameMetadata } from '../../shared/browser-screencast-protocol'
import type { BrowserScreencastViewport } from './browser-screencast-stream-types'

export type BrowserScreencastGuestViewSize = {
  width: number
  height: number
}

// The runtime's own floor for a requested viewport (normalizeScreencastViewport).
const MIN_VIEWPORT_WIDTH = 320
const MIN_VIEWPORT_HEIGHT = 240

/**
 * Whether this guest can only paint inside its embedder's element. A `<webview>` guest's
 * compositor surface is the element's size: an emulated viewport larger than that is laid out
 * at full size but its frames and `capturePage` hold only the element's top-left part, and
 * `Emulation.setVisibleSize` does not grow it (measured on Electron 43, 2026-10-18). An
 * offscreen `BrowserWindow` does grow, so it keeps the full requested size.
 */
export function isEmbedderSizedScreencastGuest(webContents: Pick<WebContents, 'getType'>): boolean {
  return typeof webContents.getType === 'function' && webContents.getType() === 'webview'
}

/** For an embedder-sized guest every live frame reports the element's CSS size, whatever is emulated. */
export function readScreencastGuestViewSize(
  metadata: BrowserScreencastFrameMetadata
): BrowserScreencastGuestViewSize | null {
  const width = metadata.deviceWidth
  const height = metadata.deviceHeight
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return null
  }
  // Why floor: a fractional element must not be asked for the pixel row it cannot paint.
  return { width: Math.floor(width), height: Math.floor(height) }
}

/**
 * The viewport to emulate: the client's request, shrunk to what the guest can paint. Frames then
 * cover the whole emulated page and report its real size, so a client letterboxes and maps
 * input against what it was sent instead of a stretched crop.
 */
export function clampScreencastViewportToGuestView(
  requested: BrowserScreencastViewport,
  view: BrowserScreencastGuestViewSize | null
): BrowserScreencastViewport {
  const { viewportWidth, viewportHeight } = requested
  if (!view || viewportWidth === undefined || viewportHeight === undefined) {
    return { ...requested }
  }
  return {
    ...requested,
    viewportWidth: Math.min(viewportWidth, Math.max(MIN_VIEWPORT_WIDTH, view.width)),
    viewportHeight: Math.min(viewportHeight, Math.max(MIN_VIEWPORT_HEIGHT, view.height))
  }
}
