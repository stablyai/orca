import type { WebContents } from 'electron'
import { browserCaptureIdle, type BrowserCaptureReservation } from './browser-capture-idle'
import { getLayoutClip } from './cdp-screenshot-layout'
import { getDesktopOwnedBrowserCapture } from './desktop-owned-browser-capture-registry'
import { encodeNativeImageScreenshot } from './cdp-screenshot-native-image'

/** Draws a hidden guest for the duration of a capture; returns its release. */
export type CapturePaintHold = () => () => void

const SCREENSHOT_TIMEOUT_MS = 8000
// Why: offsets from the capture start; the last leaves a full-page capture (~0.5 s on a tall page) time before the deadline.
const FRAME_PROBE_OFFSETS_MS = [250, 750, 1750, 3750]
const FALLBACK_CAPTURE_TIMEOUT_MS = 1000
const SCREENSHOT_TIMEOUT_MESSAGE = 'Screenshot timed out — the browser page did not draw a frame.'

type NativeCaptureAdmission = {
  promise: Promise<Electron.NativeImage>
}

// Why: native capturePage mutates the guest's presentation state and cannot be cancelled. The
// lease must outlive a single CDP request, otherwise a later request can overlap a discarded
// pulse that is still settling after its original caller returned.
const nativeCaptureAdmissions = new WeakMap<WebContents, NativeCaptureAdmission>()

function startAdmittedNativeCapture(
  webContents: WebContents,
  stayHidden = true
): Promise<Electron.NativeImage> | null {
  if (nativeCaptureAdmissions.has(webContents)) {
    return null
  }

  let promise: Promise<Electron.NativeImage>
  try {
    promise = Promise.resolve(webContents.capturePage(undefined, { stayHidden, stayAwake: false }))
  } catch {
    return null
  }

  const trackedPromise = browserCaptureIdle.trackNative(webContents, promise)
  const admission = { promise: trackedPromise }
  nativeCaptureAdmissions.set(webContents, admission)
  void promise.then(
    () => {
      if (nativeCaptureAdmissions.get(webContents) === admission) {
        nativeCaptureAdmissions.delete(webContents)
      }
    },
    () => {
      if (nativeCaptureAdmissions.get(webContents) === admission) {
        nativeCaptureAdmissions.delete(webContents)
      }
    }
  )
  return trackedPromise
}
/** Settles an owned viewport paint pulse; its pixels never become the CDP result. */
export async function drawOwnedCaptureViewport(webContents: WebContents): Promise<void> {
  const pulse = startAdmittedNativeCapture(webContents, false)
  if (!pulse) {
    throw new Error('Desktop-owned browser viewport paint pulse is unavailable')
  }
  // Native capture cannot be cancelled: keep the reservation until it settles.
  await pulse
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
// skip one; a later native capture makes the page produce a frame without issuing another CDP capture
// that could retain the full-page viewport. Resolves null when no frame arrives by the deadline; a CDP
// error is an answer. Native probe pixels are discarded and never become the screenshot result.
function captureUntilDrawn(
  webContents: WebContents,
  params: Record<string, unknown>
): Promise<{ data: string } | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let nativeProbeInFlight = false
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
      try {
        return browserCaptureIdle.trackPrimary(
          webContents,
          webContents.debugger.sendCommand('Page.captureScreenshot', requestParams)
        )
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        return null
      }
    }
    const pulseNativeFrame = (): void => {
      if (settled) {
        return
      }
      if (webContents.isDestroyed()) {
        finish(() => reject(new Error('WebContents destroyed')))
        return
      }
      if (!webContents.debugger.isAttached()) {
        finish(() => reject(new Error('Debugger detached')))
        return
      }
      if (nativeProbeInFlight) {
        return
      }
      nativeProbeInFlight = true
      const nativeProbe = startAdmittedNativeCapture(webContents)
      if (!nativeProbe) {
        nativeProbeInFlight = false
        return
      }
      void nativeProbe
        .catch(() => {})
        .finally(() => {
          // Why: the module lease outlives this invocation; this flag only suppresses its own timers.
          nativeProbeInFlight = false
        })
    }
    const deadline = setTimeout(() => finish(() => resolve(null)), SCREENSHOT_TIMEOUT_MS)
    const probes = FRAME_PROBE_OFFSETS_MS.map((offsetMs) => setTimeout(pulseNativeFrame, offsetMs))
    send(params)?.then(
      (result) => finish(() => resolve(result?.data ? { data: result.data } : null)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    )
  })
}

export function captureFullPageScreenshot(
  webContents: WebContents,
  format: 'png' | 'jpeg',
  holdPaint: CapturePaintHold,
  reservation?: BrowserCaptureReservation
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  const ownedCapture = !reservation && getDesktopOwnedBrowserCapture(webContents)
  if (ownedCapture) {
    return ownedCapture({ kind: 'full-page', format }, holdPaint).then((result) => ({
      ...result,
      format
    }))
  }
  return browserCaptureIdle.runCapture(
    webContents,
    () => captureFullPageScreenshotOnSurface(webContents, format, holdPaint),
    reservation
  )
}

async function captureFullPageScreenshotOnSurface(
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
      browserCaptureIdle.trackPrimary(
        webContents,
        webContents.debugger.sendCommand('Page.getLayoutMetrics', {})
      )
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
export function captureScreenshot(
  webContents: WebContents,
  params: Record<string, unknown> | undefined,
  holdPaint: CapturePaintHold,
  reservation?: BrowserCaptureReservation
): Promise<{ data: string }> {
  const ownedCapture =
    !reservation &&
    params?.captureBeyondViewport === true &&
    getDesktopOwnedBrowserCapture(webContents)
  if (ownedCapture) {
    return ownedCapture({ kind: 'screenshot', params }, holdPaint)
  }
  return browserCaptureIdle.runCapture(
    webContents,
    () => captureScreenshotOnSurface(webContents, params, holdPaint),
    reservation
  )
}

async function captureScreenshotOnSurface(
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
    // Why: never overlap a retained pulse or queue work beyond the fallback deadline. A busy native
    // admission preserves the existing timeout result; its image belongs to the earlier request.
    const admittedFallback = startAdmittedNativeCapture(webContents)
    const fallback = admittedFallback
      ? await withTimeout(admittedFallback, FALLBACK_CAPTURE_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MESSAGE)
          .then((image) => encodeNativeImageScreenshot(image, params))
          .catch(() => null)
      : null
    if (fallback) {
      return fallback
    }
    throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
  } finally {
    release()
  }
}
