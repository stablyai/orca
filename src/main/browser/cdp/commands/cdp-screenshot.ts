import {
  holdPaintUntilCdpCaptureSettles,
  holdPaintUntilSettled,
  type CapturePaintHold
} from '../debugger/guest-paint-hold'
import type { WebContents } from 'electron'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import {
  assertRemoteCliPageAccess,
  readRemoteCliAdmittedPage
} from '../../routing/input-ownership/remote-cli-page-admission'
import { readCaptureViewport, type CaptureViewport } from './cdp-capture-scale'

export const SCREENSHOT_TIMEOUT_MS = 8000
// Probe offsets leave time for the original capture to finish before the deadline.
const FRAME_PROBE_OFFSETS_MS = [250, 750, 1750, 3750]
// No clip: the probe's frame answers the pending capture too, and a clip shifts it by scrollY.
const FRAME_PROBE_PARAMS = { format: 'jpeg', quality: 1 }
const FALLBACK_CAPTURE_TIMEOUT_MS = 1000
const OPTIONAL_MEASURE_TIMEOUT_MS = 1000
export const SCREENSHOT_TIMEOUT_MESSAGE =
  'Screenshot timed out — the browser page did not draw a frame.'

function applyFallbackClip(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): Electron.NativeImage | null {
  if (params?.captureBeyondViewport) {
    // capturePage() only captures the painted viewport.
    return null
  }

  const clip = params?.clip
  if (!clip || typeof clip !== 'object') {
    return image
  }
  const clipRect = clip as Record<string, unknown>

  const x = typeof clipRect.x === 'number' ? clipRect.x : Number.NaN
  const y = typeof clipRect.y === 'number' ? clipRect.y : Number.NaN
  const width = typeof clipRect.width === 'number' ? clipRect.width : Number.NaN
  const height = typeof clipRect.height === 'number' ? clipRect.height : Number.NaN
  const scale =
    typeof clipRect.scale === 'number' && Number.isFinite(clipRect.scale) && clipRect.scale > 0
      ? clipRect.scale
      : 1

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null
  }

  const cropRect = {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
  const imageSize = image.getSize()
  if (
    cropRect.x < 0 ||
    cropRect.y < 0 ||
    cropRect.width <= 0 ||
    cropRect.height <= 0 ||
    cropRect.x + cropRect.width > imageSize.width ||
    cropRect.y + cropRect.height > imageSize.height
  ) {
    return null
  }

  return image.crop(cropRect)
}

function encodeNativeImageScreenshot(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): { data: string } | null {
  if (image.isEmpty()) {
    return null
  }

  const clippedImage = applyFallbackClip(image, params)
  if (!clippedImage || clippedImage.isEmpty()) {
    return null
  }

  const format = params?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality =
    typeof params?.quality === 'number' && Number.isFinite(params.quality)
      ? Math.max(0, Math.min(100, Math.round(params.quality)))
      : undefined
  const buffer = format === 'jpeg' ? clippedImage.toJPEG(quality ?? 90) : clippedImage.toPNG()
  return { data: buffer.toString('base64') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

// Undrawn pages can leave captures pending; cheap probes trigger a frame for the original request.
export function captureUntilDrawn(
  webContents: WebContents,
  params: Record<string, unknown>,
  holdPaint: CapturePaintHold
): Promise<{ data: string } | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      probes.forEach(clearTimeout)
      settle()
    }
    const send = (
      requestParams: Record<string, unknown>
    ): Promise<{ data?: string } | undefined> | null => {
      if (webContents.isDestroyed()) {
        finish(() => reject(new Error('WebContents destroyed')))
        return null
      }
      if (!webContents.debugger.isAttached()) {
        finish(() => reject(new Error('Debugger detached')))
        return null
      }
      try {
        // Recheck access because navigation can leave the SSH host’s admitted pages between probes.
        assertRemoteCliPageAccess(webContents.id)
      } catch (error) {
        finish(() => reject(error))
        return null
      }
      try {
        webContents.invalidate()
      } catch {
        // Guest teardown can reject repaint requests; still try CDP.
      }
      return holdPaintUntilCdpCaptureSettles(webContents, holdPaint, () =>
        sendGuestCdpCommand(webContents, 'Page.captureScreenshot', requestParams)
      ).then((result) => {
        const data = isRecord(result) ? result.data : undefined
        return typeof data === 'string' ? { data } : undefined
      })
    }
    const deadline = setTimeout(() => finish(() => resolve(null)), SCREENSHOT_TIMEOUT_MS)
    let probes: NodeJS.Timeout[] = []
    let captureSent = false
    const sendCapture = (): void => {
      if (captureSent || settled) {
        return
      }
      captureSent = true
      send(params)?.then(
        (result) => finish(() => resolve(result?.data ? { data: result.data } : null)),
        (error: unknown) =>
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      )
    }
    if (params.clip || params.captureBeyondViewport) {
      // A probe sent during a clipped or beyond-viewport capture leaves its emulation applied
      // afterwards; one sent just before is safe, and the emulation change then draws the frame.
      // Wait for its frame too: a capture pending beside it is answered with that unclipped frame.
      probes = [setTimeout(sendCapture, FRAME_PROBE_OFFSETS_MS[0])]
      send(FRAME_PROBE_PARAMS)?.then(sendCapture, sendCapture)
    } else {
      probes = FRAME_PROBE_OFFSETS_MS.map((offsetMs) =>
        setTimeout(() => send(FRAME_PROBE_PARAMS)?.catch(() => {}), offsetMs)
      )
      sendCapture()
    }
  })
}

/** Reads what a capture may ask for; layout and script answer before the page draws. */
export async function measureCaptureViewport(
  webContents: WebContents,
  timeoutMs = SCREENSHOT_TIMEOUT_MS
): Promise<CaptureViewport | null> {
  const read = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    withTimeout(
      sendGuestCdpCommand(webContents, method, params),
      timeoutMs,
      'Screenshot timed out — the browser page did not respond.'
    )
  const metrics = await read('Page.getLayoutMetrics', {})
  // CDP, not executeJavaScript: Electron holds that until the page stops loading.
  const evaluated = await read('Runtime.evaluate', {
    expression: 'window.devicePixelRatio',
    returnByValue: true
  }).catch(() => null)
  const ratio = isRecord(evaluated) && isRecord(evaluated.result) ? evaluated.result.value : null
  return readCaptureViewport(metrics, typeof ratio === 'number' ? ratio : null)
}

// Prefer CDP for beyond-viewport capture; bound stalls below agent-browser’s 30-second timeout.
export async function captureScreenshot(
  webContents: WebContents,
  params: Record<string, unknown> | undefined,
  holdPaint: CapturePaintHold
): Promise<{ data: string }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }
  if (!webContents.debugger.isAttached()) {
    throw new Error('Debugger not attached')
  }

  const screenshotParams: Record<string, unknown> = {}
  if (params?.format) {
    screenshotParams.format = params.format
  }
  if (params?.quality) {
    screenshotParams.quality = params.quality
  }
  if (params?.clip) {
    screenshotParams.clip = params.clip
  }
  if (params?.captureBeyondViewport != null) {
    screenshotParams.captureBeyondViewport = params.captureBeyondViewport
  }
  if (params?.fromSurface != null) {
    screenshotParams.fromSurface = params.fromSurface
  }

  const release = holdPaint()
  try {
    if (!screenshotParams.clip && !screenshotParams.captureBeyondViewport) {
      // A page too busy to report its layout is captured as asked, not held up for the full budget.
      const viewport = await measureCaptureViewport(webContents, OPTIONAL_MEASURE_TIMEOUT_MS).catch(
        () => null
      )
      if (viewport?.emulatedDensity) {
        // Chromium copies an emulated ratio's full pixel count from the smaller drawn surface and tiles it.
        screenshotParams.clip = { ...viewport.viewport, scale: viewport.scale }
      }
    }
    const frame = await captureUntilDrawn(webContents, screenshotParams, holdPaint)
    if (frame) {
      return frame
    }
    const fallback = await readRemoteCliAdmittedPage(webContents.id, () =>
      withTimeout(
        holdPaintUntilSettled(holdPaint, () => webContents.capturePage()),
        FALLBACK_CAPTURE_TIMEOUT_MS,
        SCREENSHOT_TIMEOUT_MESSAGE
      )
        .then((image) => encodeNativeImageScreenshot(image, params))
        .catch(() => null)
    )
    if (fallback) {
      return fallback
    }
    throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
  } finally {
    release()
  }
}
