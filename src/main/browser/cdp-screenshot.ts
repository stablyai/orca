import type { WebContents } from 'electron'

/** Draws a hidden guest for the duration of a capture; returns its release. */
export type CapturePaintHold = () => () => void

const SCREENSHOT_TIMEOUT_MS = 8000
// Why: offsets from the capture start; the last leaves a full-page capture (~0.5 s on a tall page) time before the deadline.
const FRAME_PROBE_OFFSETS_MS = [250, 750, 1750, 3750]
// Why: a 1x1 request is cheap; the frame it makes the page produce also answers the pending capture.
const FRAME_PROBE_PARAMS = {
  format: 'jpeg',
  quality: 1,
  clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }
}
const FALLBACK_CAPTURE_TIMEOUT_MS = 1000
const SCREENSHOT_TIMEOUT_MESSAGE = 'Screenshot timed out — the browser page did not draw a frame.'

function applyFallbackClip(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): Electron.NativeImage | null {
  if (params?.captureBeyondViewport) {
    // Why: capturePage() can only see the currently painted viewport. If the
    // caller asked for beyond-viewport pixels, returning a viewport-sized image
    // would silently lie about what was captured.
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

function getLayoutClip(metrics: {
  cssContentSize?: { width?: number; height?: number }
  contentSize?: { width?: number; height?: number }
}): { x: number; y: number; width: number; height: number; scale: number } | null {
  // Why: Page.captureScreenshot clip coordinates are in CSS pixels. On HiDPI
  // Electron guests, `contentSize` can reflect device pixels, which makes
  // Chromium tile the page into a duplicated 2x2 grid. Prefer cssContentSize
  // and only fall back to contentSize when older Chromium builds omit it.
  const size = metrics.cssContentSize ?? metrics.contentSize
  const width = size?.width
  const height = size?.height
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null
  }

  return {
    x: 0,
    y: 0,
    width: Math.ceil(width),
    height: Math.ceil(height),
    scale: 1
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

// Why: a request made before the held page is drawn never resolves, and an offscreen drawn page can
// skip one; a later request makes the page produce a frame, which answers every pending request.
// So the capture is sent once and cheap probes follow until it answers. Resolves null when no frame
// arrives by the deadline; a CDP error is an answer. Unanswered probes settle on the next frame or
// reject on detach.
function captureUntilDrawn(
  webContents: WebContents,
  params: Record<string, unknown>
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
        webContents.invalidate()
      } catch {
        // Some guest teardown paths reject repaint requests. Fall through to CDP.
      }
      return webContents.debugger.sendCommand('Page.captureScreenshot', requestParams)
    }
    const deadline = setTimeout(() => finish(() => resolve(null)), SCREENSHOT_TIMEOUT_MS)
    const probes = FRAME_PROBE_OFFSETS_MS.map((offsetMs) =>
      setTimeout(() => send(FRAME_PROBE_PARAMS)?.catch(() => {}), offsetMs)
    )
    send(params)?.then(
      (result) => finish(() => resolve(result?.data ? { data: result.data } : null)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    )
  })
}

export async function captureFullPageScreenshot(
  webContents: WebContents,
  format: 'png' | 'jpeg',
  holdPaint: CapturePaintHold
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }
  if (!webContents.debugger.isAttached()) {
    throw new Error('Debugger not attached')
  }

  const release = holdPaint()
  try {
    // Why: layout works on an undrawn page, so only the pixel capture waits for a frame.
    const layoutMetrics: Promise<Parameters<typeof getLayoutClip>[0]> =
      webContents.debugger.sendCommand('Page.getLayoutMetrics', {})
    const metrics = await withTimeout(
      layoutMetrics,
      SCREENSHOT_TIMEOUT_MS,
      'Screenshot timed out — the browser page did not respond.'
    )
    const clip = getLayoutClip(metrics)
    if (!clip) {
      throw new Error('Unable to determine full-page screenshot bounds')
    }
    const frame = await captureUntilDrawn(webContents, {
      format,
      captureBeyondViewport: true,
      clip
    })
    if (!frame) {
      throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
    }
    return { data: frame.data, format }
  } finally {
    release()
  }
}

// Why: Page.captureScreenshot honours clip and beyond-viewport params that capturePage() can't.
// Bounded so agent-browser doesn't hang on its 30s CDP timeout if the debugger stalls.
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
    const frame = await captureUntilDrawn(webContents, screenshotParams)
    if (frame) {
      return frame
    }
    // Why: capturePage is only a best-effort fallback for a page that never answered.
    const fallback = await withTimeout(
      Promise.resolve().then(() => webContents.capturePage()),
      FALLBACK_CAPTURE_TIMEOUT_MS,
      SCREENSHOT_TIMEOUT_MESSAGE
    )
      .then((image) => encodeNativeImageScreenshot(image, params))
      .catch(() => null)
    if (fallback) {
      return fallback
    }
    throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
  } finally {
    release()
  }
}
