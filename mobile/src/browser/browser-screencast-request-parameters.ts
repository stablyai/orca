import type { BrowserScreencastFormat } from '../transport/browser-screencast-protocol'

/**
 * Everything the pane asks a screencast for that is the same on every platform, and the assembly
 * both `browser-screencast-request.ts` and its `.web.ts` sibling call.
 *
 * Separate from them because a `.web.ts` cannot import a value from the file it shadows — the
 * bundler resolves the specifier back to the sibling itself — and the alternative is two copies of
 * these constants drifting apart. Only the mobile view's device scale factor differs by platform,
 * and it arrives as an argument.
 */

export type BrowserStreamLayout = {
  width: number
  height: number
}

export type MobileBrowserScreencastRequest = {
  format: BrowserScreencastFormat
  quality: number
  maxWidth: number
  maxHeight: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame: number
  minFrameIntervalMs: number
}

export type MobileBrowserViewMode = 'web' | 'mobile'

export const BROWSER_FRAME_FORMAT: BrowserScreencastFormat = 'jpeg'
export const BROWSER_FRAME_QUALITY = 72
// Why: menus/popovers can be a single compositor update. Skipping CDP frames
// can miss that final static state; time throttling below still caps throughput.
const BROWSER_FRAME_EVERY_NTH_FRAME = 1
export const MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS = 100
const BROWSER_MIN_FRAME_WIDTH = 320
const BROWSER_MIN_FRAME_HEIGHT = 240
const BROWSER_MAX_FRAME_WIDTH = 2400
const BROWSER_MAX_FRAME_HEIGHT = 2160
const BROWSER_MAX_STREAM_SCALE = 2.5

/** What a phone's mobile view asks for when nothing is bounding the frame it gets back. */
export const MOBILE_VIEW_DEVICE_SCALE_FACTOR = 2

export function assembleMobileBrowserScreencastRequest(
  layout: BrowserStreamLayout | null,
  pixelRatio: number,
  viewMode: MobileBrowserViewMode,
  mobileViewDeviceScaleFactor: number
): MobileBrowserScreencastRequest | null {
  if (!layout || layout.width <= 0 || layout.height <= 0) {
    return null
  }
  // Why: mobile should improve image density without changing the desktop
  // browser viewport. Sending viewport params puts Chromium in phone emulation.
  const streamScale = clamp(
    Math.min(Number.isFinite(pixelRatio) ? pixelRatio : 1, BROWSER_MAX_STREAM_SCALE),
    1,
    BROWSER_MAX_STREAM_SCALE
  )
  return {
    format: BROWSER_FRAME_FORMAT,
    quality: BROWSER_FRAME_QUALITY,
    maxWidth: clamp(
      Math.round(layout.width * streamScale),
      BROWSER_MIN_FRAME_WIDTH,
      BROWSER_MAX_FRAME_WIDTH
    ),
    maxHeight: clamp(
      Math.round(layout.height * streamScale),
      BROWSER_MIN_FRAME_HEIGHT,
      BROWSER_MAX_FRAME_HEIGHT
    ),
    everyNthFrame: BROWSER_FRAME_EVERY_NTH_FRAME,
    minFrameIntervalMs: MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS,
    ...(viewMode === 'mobile'
      ? {
          // Why: mobile view should trigger responsive CSS while matching the
          // phone's measured browser area instead of a fixed device preset.
          viewportWidth: Math.round(layout.width),
          viewportHeight: Math.round(layout.height),
          deviceScaleFactor: mobileViewDeviceScaleFactor,
          mobile: true
        }
      : {})
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
