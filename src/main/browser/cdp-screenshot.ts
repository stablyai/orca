import type { WebContents } from 'electron'

const SCREENSHOT_TIMEOUT_MS = 8000
const SCREENSHOT_TIMEOUT_MESSAGE =
  'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'

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

  const x = typeof clipRect.x === 'number' ? clipRect.x : NaN
  const y = typeof clipRect.y === 'number' ? clipRect.y : NaN
  const width = typeof clipRect.width === 'number' ? clipRect.width : NaN
  const height = typeof clipRect.height === 'number' ? clipRect.height : NaN
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

async function sendCommandWithTimeout<T>(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      webContents.debugger.sendCommand(method, params ?? {}) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), SCREENSHOT_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function captureFullPageScreenshot(
  webContents: WebContents,
  format: 'png' | 'jpeg' = 'png'
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }
  const dbg = webContents.debugger
  if (!dbg.isAttached()) {
    throw new Error('Debugger not attached')
  }

  try {
    webContents.invalidate()
  } catch {
    // Some guest teardown paths reject repaint requests. Fall through to CDP.
  }

  const metrics = await sendCommandWithTimeout<{
    cssContentSize?: { width?: number; height?: number }
    contentSize?: { width?: number; height?: number }
  }>(webContents, 'Page.getLayoutMetrics', undefined, SCREENSHOT_TIMEOUT_MESSAGE)
  const clip = getLayoutClip(metrics)
  if (!clip) {
    throw new Error('Unable to determine full-page screenshot bounds')
  }

  const { data } = await sendCommandWithTimeout<{ data: string }>(
    webContents,
    'Page.captureScreenshot',
    {
      format,
      captureBeyondViewport: true,
      clip
    },
    SCREENSHOT_TIMEOUT_MESSAGE
  )

  return { data, format }
}

// Why: Electron's capturePage() is unreliable on webview guests — the compositor
// may not produce frames when the webview panel is inactive, unfocused, or in a
// split-pane layout. Instead, use the debugger's Page.captureScreenshot which
// renders server-side in the Blink compositor and doesn't depend on OS-level
// window focus or display state. Guard with a timeout so agent-browser doesn't
// hang on its 30s CDP timeout if the debugger stalls.
export function captureScreenshot(
  webContents: WebContents,
  params: Record<string, unknown> | undefined,
  onResult: (result: unknown) => void,
  onError: (message: string) => void
): void {
  if (webContents.isDestroyed()) {
    onError('WebContents destroyed')
    return
  }
  const dbg = webContents.debugger
  if (!dbg.isAttached()) {
    onError('Debugger not attached')
    return
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

  let settled = false
  // Why: a compositor invalidate is cheap and can recover guest instances that
  // are visible but have not produced a fresh frame since being reclaimed into
  // the active browser tab.
  try {
    webContents.invalidate()
  } catch {
    // Some guest teardown paths reject repaint requests. Fall through to CDP.
  }
  const timer = setTimeout(async () => {
    if (!settled) {
      try {
        const image = await webContents.capturePage()
        if (settled) {
          return
        }
        const fallback = encodeNativeImageScreenshot(image, params)
        if (fallback) {
          if (settled) {
            return
          }
          settled = true
          onResult(fallback)
          return
        }
      } catch {
        // Fall through to the original timeout error below.
      }

      if (!settled) {
        settled = true
        onError(SCREENSHOT_TIMEOUT_MESSAGE)
      }
    }
  }, SCREENSHOT_TIMEOUT_MS)

  dbg
    .sendCommand('Page.captureScreenshot', screenshotParams)
    .then((result) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        onResult(result)
      }
    })
    .catch((err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        onError((err as Error).message)
      }
    })
}
