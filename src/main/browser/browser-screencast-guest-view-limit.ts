import type { WebContents } from 'electron'
import type { BrowserScreencastFrameMetadata } from '../../shared/browser-screencast-protocol'
import type { BrowserScreencastViewport } from './browser-screencast-stream-types'

export type BrowserScreencastGuestViewSize = {
  width: number
  height: number
}

// Match normalizeScreencastViewport's minimum dimensions.
const MIN_VIEWPORT_WIDTH = 320
const MIN_VIEWPORT_HEIGHT = 240

// Webview compositors stay bounded by their embedder even after Emulation.setVisibleSize.
// Emulating a larger viewport crops the layout; offscreen BrowserWindows can grow instead.
export function isEmbedderSizedScreencastGuest(webContents: Pick<WebContents, 'getType'>): boolean {
  return typeof webContents.getType === 'function' && webContents.getType() === 'webview'
}

/** Webview frame dimensions reveal the embedder size regardless of viewport emulation. */
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
  // Floor fractional bounds so the guest is never asked to paint an unavailable pixel row.
  return { width: Math.floor(width), height: Math.floor(height) }
}

// Clamp to guest bounds while preserving the runtime viewport floor.
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
