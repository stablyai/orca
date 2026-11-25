import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastViewport
} from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import type { BrowserScreencastParams } from './browser-screencast-contracts'

export function normalizeScreencastViewport(
  params: BrowserScreencastParams
): BrowserScreencastViewport {
  return {
    viewportWidth: clampOptionalInteger(params.viewportWidth, 320, 3840),
    viewportHeight: clampOptionalInteger(params.viewportHeight, 240, 2160),
    deviceScaleFactor: clampOptionalNumber(params.deviceScaleFactor, 1, 4),
    mobile: params.mobile === true
  }
}

export function normalizeScreencastFrameBudget(
  params: BrowserScreencastParams
): BrowserScreencastFrameBudget {
  return {
    quality: clampInteger(params.quality, 10, 100, 70),
    maxWidth: clampInteger(params.maxWidth, 320, 3840, 1440),
    maxHeight: clampInteger(params.maxHeight, 240, 2160, 1200),
    everyNthFrame: clampInteger(params.everyNthFrame, 1, 10, 2),
    minFrameIntervalMs: clampInteger(params.minFrameIntervalMs, 0, 1000, 0)
  }
}

export function hasScreencastViewportSize(viewport: BrowserScreencastViewport): boolean {
  return viewport.viewportWidth !== undefined && viewport.viewportHeight !== undefined
}

export function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampOptionalInteger(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampOptionalNumber(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, value))
}
