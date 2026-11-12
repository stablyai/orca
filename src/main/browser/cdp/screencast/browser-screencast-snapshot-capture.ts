import { Buffer } from 'node:buffer'
import { nativeImage, type Debugger, type NativeImage, type WebContents } from 'electron'
import { readBrowserScreencastImageSize } from './browser-screencast-image-size'
import { runDebuggerCommandWithTimeout } from './browser-screencast-debugger-command'
import {
  holdPaintUntilCdpCaptureSettles,
  holdPaintUntilSettled
} from '../debugger/guest-paint-hold'
import type {
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'
import { positiveInteger, scaleSnapshotToFit } from './browser-screencast-viewport-fit'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

// Bound capture time so queued viewport updates and stop can proceed.
const SNAPSHOT_CAPTURE_TIMEOUT_MS = 10_000

type BrowserScreencastSnapshotCaptureDeps = {
  webContents: WebContents
  dbg: Debugger
  options: BrowserScreencastOptions
  isClosed: () => boolean
  isStopping: () => boolean
  // Stop must not wait out a capturePage a non-drawing guest leaves pending; its result is stale anyway.
  stopSignal: AbortSignal
  getSeq: () => number
  queueFrame: (frame: PendingScreencastFrame) => void
  applyDeviceMetricsOverride: () => Promise<void>
}

export type BrowserScreencastSnapshotCapture = {
  emitSnapshotFrame: (initialOnly: boolean, generation?: number) => Promise<void>
  scheduleNavigationFrameCapture: () => void
  clearNavigationCaptureTimer: () => void
  bumpGeneration: () => void
}

export function createBrowserScreencastSnapshotCapture(
  deps: BrowserScreencastSnapshotCaptureDeps
): BrowserScreencastSnapshotCapture {
  const { webContents, dbg, options, isClosed, isStopping, stopSignal, getSeq, queueFrame } = deps
  const { applyDeviceMetricsOverride } = deps
  const encodeSnapshot = (image: NativeImage): Buffer => {
    const capture = scaleSnapshotToFit(image, options)
    return options.format === 'png' ? capture.toPNG() : capture.toJPEG(options.quality)
  }
  const { holdPaint } = options

  let snapshotGeneration = 0
  let navigationCaptureTimer: ReturnType<typeof setTimeout> | null = null

  const clearNavigationCaptureTimer = (): void => {
    if (navigationCaptureTimer) {
      clearTimeout(navigationCaptureTimer)
      navigationCaptureTimer = null
    }
  }

  const scheduleNavigationFrameCapture = (): void => {
    if (isClosed() || isStopping()) {
      return
    }
    clearNavigationCaptureTimer()
    const generation = ++snapshotGeneration
    // Static pages may finish navigation without emitting a live frame.
    navigationCaptureTimer = setTimeout(() => {
      navigationCaptureTimer = null
      void emitSnapshotFrame(false, generation)
    }, 250)
  }

  const isSnapshotStale = (initialOnly: boolean, generation?: number): boolean =>
    isClosed() ||
    isStopping() ||
    (initialOnly && getSeq() > 0) ||
    (generation !== undefined && generation !== snapshotGeneration)

  const emitSnapshotFrame = async (initialOnly: boolean, generation?: number): Promise<void> => {
    if (isSnapshotStale(initialOnly, generation)) {
      return
    }
    try {
      const viewportWidth = positiveInteger(options.viewportWidth)
      const viewportHeight = positiveInteger(options.viewportHeight)
      let image: Uint8Array | null = null
      await applyDeviceMetricsOverride()
      if (isSnapshotStale(initialOnly, generation)) {
        return
      }
      if (viewportWidth && viewportHeight && typeof webContents.capturePage === 'function') {
        try {
          // Prefer capturePage to avoid CDP tiling; stopped compositing can leave it pending.
          const nativeImage = await withTimeout(
            waitForPromiseWithSignal(
              holdPaintUntilSettled(holdPaint, () =>
                webContents.capturePage({
                  x: 0,
                  y: 0,
                  width: viewportWidth,
                  height: viewportHeight
                })
              ),
              stopSignal
            ),
            SNAPSHOT_CAPTURE_TIMEOUT_MS,
            null
          )
          if (isSnapshotStale(initialOnly, generation)) {
            return
          }
          if (nativeImage) {
            const buffer = encodeSnapshot(nativeImage)
            if (buffer.byteLength > 0) {
              image = new Uint8Array(buffer)
            }
          }
        } catch {
          image = null
        }
      }
      if (!image) {
        const screenshotParams = {
          format: options.format,
          ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
          ...(viewportWidth && viewportHeight
            ? {
                // Keep fallback frames in the live viewport's coordinate space under mobile emulation and DPR.
                clip: {
                  x: 0,
                  y: 0,
                  width: viewportWidth,
                  height: viewportHeight,
                  scale: 1
                }
              }
            : {}),
          captureBeyondViewport: false
        }
        // Not raced with stop: a clipped capture Chromium finishes late re-applies the phone metrics after the clear.
        const result = await runDebuggerCommandWithTimeout('Page.captureScreenshot', () =>
          holdPaintUntilCdpCaptureSettles(webContents, holdPaint, () =>
            dbg.sendCommand('Page.captureScreenshot', screenshotParams)
          )
        )
        if (isSnapshotStale(initialOnly, generation)) {
          return
        }
        const payload =
          result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
        const data = typeof payload.data === 'string' ? payload.data : null
        if (!data) {
          return
        }
        const bytes = Buffer.from(data, 'base64')
        const size = readBrowserScreencastImageSize(bytes, options.format)
        image = new Uint8Array(
          size && (size.width > options.maxWidth || size.height > options.maxHeight)
            ? encodeSnapshot(nativeImage.createFromBuffer(bytes))
            : bytes
        )
      }
      if (isSnapshotStale(initialOnly, generation)) {
        return
      }
      const imageSize = readBrowserScreencastImageSize(image, options.format)
      const baseMetadata =
        viewportWidth && viewportHeight
          ? { deviceWidth: viewportWidth, deviceHeight: viewportHeight }
          : imageSize
            ? { deviceWidth: imageSize.width, deviceHeight: imageSize.height }
            : {}
      queueFrame({
        // Include dimensions so mobile clients do not stretch static-page fallback frames.
        metadata: {
          ...baseMetadata,
          ...(imageSize ? { imageWidth: imageSize.width, imageHeight: imageSize.height } : {})
        },
        image
      })
    } catch {
      // Live frames can still arrive after a fallback capture fails.
    }
  }

  return {
    emitSnapshotFrame,
    scheduleNavigationFrameCapture,
    clearNavigationCaptureTimer,
    bumpGeneration: () => {
      snapshotGeneration += 1
    }
  }
}
