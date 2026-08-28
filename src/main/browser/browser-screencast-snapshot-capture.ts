import { Buffer } from 'node:buffer'
import type { Debugger, WebContents } from 'electron'
import { readBrowserScreencastImageSize } from './browser-screencast-image-size'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import type {
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'
import { positiveInteger, scaleSnapshotToFit } from './browser-screencast-viewport-fit'

type BrowserScreencastSnapshotCaptureDeps = {
  webContents: WebContents
  dbg: Debugger
  options: BrowserScreencastOptions
  isClosed: () => boolean
  isStopping: () => boolean
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
  const { webContents, dbg, options, isClosed, isStopping, getSeq, queueFrame } = deps
  const { applyDeviceMetricsOverride } = deps

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
    // Why: static pages can finish navigation without producing a live
    // screencast frame, leaving mobile on the previous page image.
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
          // Why: CDP captureScreenshot can tile BrowserView surfaces under
          // mobile emulation; Electron captures the actual visible viewport.
          const nativeImage = await webContents.capturePage({
            x: 0,
            y: 0,
            width: viewportWidth,
            height: viewportHeight
          })
          const capture = scaleSnapshotToFit(nativeImage, options)
          const buffer =
            options.format === 'png' ? capture.toPNG() : capture.toJPEG(options.quality)
          if (buffer.byteLength > 0) {
            image = new Uint8Array(buffer)
          }
        } catch {
          image = null
        }
      }
      // Why: Page.startScreencast may not produce a frame for an already-painted
      // blank/static page, which leaves remote browser clients showing only the shell.
      if (!image) {
        const result = await sendDebuggerCommand(dbg, 'Page.captureScreenshot', {
          format: options.format,
          ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
          ...(viewportWidth && viewportHeight
            ? {
                // Why: mobile emulation + DPR can make Chromium capture a larger
                // surface than the visual viewport. Clipping keeps fallback frames
                // in the same coordinate space as live screencast frames.
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
        })
        if (isSnapshotStale(initialOnly, generation)) {
          return
        }
        const payload =
          result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
        const data = typeof payload.data === 'string' ? payload.data : null
        if (!data) {
          return
        }
        image = new Uint8Array(Buffer.from(data, 'base64'))
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
        // Why: static pages may only produce this fallback capture. Without
        // dimensions, mobile clients stretch it to the phone aspect ratio.
        metadata: {
          ...baseMetadata,
          ...(imageSize ? { imageWidth: imageSize.width, imageHeight: imageSize.height } : {})
        },
        image
      })
    } catch {
      // Best effort only: live Page.screencastFrame events still drive the stream.
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
