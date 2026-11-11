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

// Native socket frames have no bridge per-message cap; request desired density. Web sibling budgets area to fit its cap.
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
