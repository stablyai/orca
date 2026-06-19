import type { BrowserScreencastFormat } from '../transport/browser-screencast-protocol'

export type BrowserStreamLayout = {
  width: number
  height: number
}

export type MobileBrowserScreencastRequest = {
  format: BrowserScreencastFormat
  quality: number
  maxWidth: number
  maxHeight: number
  everyNthFrame: number
  minFrameIntervalMs: number
}

const BROWSER_FRAME_FORMAT: BrowserScreencastFormat = 'jpeg'
const BROWSER_FRAME_QUALITY = 72
// Why: menus/popovers can be a single compositor update. Skipping CDP frames
// can miss that final static state; time throttling below still caps throughput.
const BROWSER_FRAME_EVERY_NTH_FRAME = 1
export const MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS = 100
const BROWSER_MIN_FRAME_WIDTH = 320
const BROWSER_MIN_FRAME_HEIGHT = 240
const BROWSER_MAX_FRAME_WIDTH = 2400
const BROWSER_MAX_FRAME_HEIGHT = 2160
const BROWSER_MAX_STREAM_SCALE = 2.5

export function buildMobileBrowserScreencastRequest(
  layout: BrowserStreamLayout | null,
  pixelRatio: number
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
    minFrameIntervalMs: MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
