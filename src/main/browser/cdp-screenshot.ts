import type { WebContents } from 'electron'
import {
  assertBrowserScreenshotBase64,
  assertBrowserScreenshotGeometry,
  BROWSER_SCREENSHOT_BUSY_ERROR,
  BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
} from './browser-screenshot-limits'
import {
  startBrowserFallbackCapture,
  startBrowserScreenshotCommand
} from './browser-screenshot-admission'
import { encodeNativeImageScreenshot } from './native-image-screenshot-encoder'

const SCREENSHOT_TIMEOUT_MS = 8000
const FALLBACK_CAPTURE_TIMEOUT_MS = 1000
const SCREENSHOT_TIMEOUT_MESSAGE =
  'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
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

  const clip = {
    x: 0,
    y: 0,
    width: Math.ceil(width),
    height: Math.ceil(height),
    scale: 1
  }
  assertBrowserScreenshotGeometry(clip.width, clip.height)
  return clip
}

async function sendCommandWithTimeout<T>(
  webContents: WebContents,
  method: 'Page.captureScreenshot' | 'Page.getLayoutMetrics',
  params: Record<string, unknown> | undefined,
  timeoutMessage: string
): Promise<T> {
  const command = startBrowserScreenshotCommand<T>(webContents, method, params ?? {})
  if (!command) {
    throw new Error(BROWSER_SCREENSHOT_BUSY_ERROR)
  }
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      command,
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
    { format, captureBeyondViewport: true, clip },
    SCREENSHOT_TIMEOUT_MESSAGE
  )
  assertBrowserScreenshotBase64(data)

  return { data, format }
}

function assertCaptureClipWithinLimit(params: Record<string, unknown> | undefined): void {
  const clip = params?.clip
  if (!clip || typeof clip !== 'object') {
    return
  }
  const values = clip as Record<string, unknown>
  if (typeof values.width !== 'number' || typeof values.height !== 'number') {
    return
  }
  const scale = typeof values.scale === 'number' ? values.scale : 1
  assertBrowserScreenshotGeometry(values.width, values.height, scale)
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
  try {
    assertCaptureClipWithinLimit(params)
  } catch (error) {
    onError(error instanceof Error ? error.message : BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
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
  const capture = startBrowserScreenshotCommand(
    webContents,
    'Page.captureScreenshot',
    screenshotParams
  )
  if (!capture) {
    onError(BROWSER_SCREENSHOT_BUSY_ERROR)
    return
  }

  let settled = false
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const clearTimers = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }
  const settleResult = (result: unknown): void => {
    if (settled) {
      return
    }
    const data =
      result && typeof result === 'object' ? (result as { data?: unknown }).data : undefined
    try {
      if (typeof data === 'string') {
        assertBrowserScreenshotBase64(data)
      }
    } catch (error) {
      settleError(error instanceof Error ? error.message : BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
      return
    }
    settled = true
    clearTimers()
    onResult(result)
  }
  const settleError = (message: string): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimers()
    onError(message)
  }
  // Why: a compositor invalidate is cheap and can recover guest instances that
  // are visible but have not produced a fresh frame since being reclaimed into
  // the active browser tab.
  try {
    webContents.invalidate()
  } catch {
    // Some guest teardown paths reject repaint requests. Fall through to CDP.
  }
  timeoutTimer = setTimeout(() => {
    if (settled) {
      return
    }
    // Why: capturePage is only a best-effort fallback. If it also stalls, the
    // CDP proxy must still settle instead of inheriting the compositor hang.
    fallbackTimer = setTimeout(
      () => settleError(SCREENSHOT_TIMEOUT_MESSAGE),
      FALLBACK_CAPTURE_TIMEOUT_MS
    )
    const fallbackCapture = startBrowserFallbackCapture(webContents)
    if (!fallbackCapture) {
      settleError(BROWSER_SCREENSHOT_BUSY_ERROR)
      return
    }
    void fallbackCapture.then(
      (image) => {
        if (settled) {
          return
        }
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = null
        }
        let fallback: { data: string } | null = null
        try {
          fallback = encodeNativeImageScreenshot(image, params)
        } catch (error) {
          settleError(
            error instanceof Error && error.message === BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
              ? error.message
              : SCREENSHOT_TIMEOUT_MESSAGE
          )
          return
        }
        if (fallback) {
          settleResult(fallback)
          return
        }
        settleError(SCREENSHOT_TIMEOUT_MESSAGE)
      },
      () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = null
        }
        settleError(SCREENSHOT_TIMEOUT_MESSAGE)
      }
    )
  }, SCREENSHOT_TIMEOUT_MS)

  void capture
    .then((result) => settleResult(result))
    .catch((err) => settleError((err as Error).message))
}
