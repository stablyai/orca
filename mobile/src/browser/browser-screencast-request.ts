import {
  assembleMobileBrowserScreencastRequest,
  MOBILE_VIEW_DEVICE_SCALE_FACTOR,
  type BrowserStreamLayout,
  type MobileBrowserScreencastRequest,
  type MobileBrowserViewMode
} from './browser-screencast-request-parameters'

export { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request-parameters'
export type {
  BrowserStreamLayout,
  MobileBrowserScreencastRequest,
  MobileBrowserViewMode
} from './browser-screencast-request-parameters'

/**
 * Native: nothing bounds one frame, so the mobile view asks for the density it wants.
 *
 * The socket delivers a screencast frame as its own message with no per-message ceiling above it.
 * The `.web.ts` sibling has one, and budgets the area it asks for against it.
 */
export function buildMobileBrowserScreencastRequest(
  layout: BrowserStreamLayout | null,
  pixelRatio: number,
  viewMode: MobileBrowserViewMode = 'web'
): MobileBrowserScreencastRequest | null {
  return assembleMobileBrowserScreencastRequest(
    layout,
    pixelRatio,
    viewMode,
    MOBILE_VIEW_DEVICE_SCALE_FACTOR
  )
}
