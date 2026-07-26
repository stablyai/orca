import type { WebContents } from 'electron'
import { BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES } from './browser-screenshot-limits'

let activeCaptures = 0
let admissionEpoch = 0

function startBrowserScreenshotOperation<T>(
  webContents: WebContents,
  start: () => Promise<T>
): Promise<T> | null {
  if (activeCaptures >= BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES) {
    return null
  }
  activeCaptures += 1
  const operationEpoch = admissionEpoch

  let released = false
  const onDestroyed = (): void => release()
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    webContents.removeListener?.('destroyed', onDestroyed)
    if (operationEpoch === admissionEpoch) {
      activeCaptures = Math.max(0, activeCaptures - 1)
    }
  }
  // Why: destroying the native target releases its capture resources even if Chromium omits rejection.
  webContents.once?.('destroyed', onDestroyed)

  let command: Promise<T>
  try {
    command = start()
  } catch (error) {
    release()
    return Promise.reject(error)
  }
  // Why: a timed-out native command cannot be cancelled, so it owns its slot until it truly settles.
  void command.then(release, release)
  return command
}

export function startBrowserScreenshotCommand<T>(
  webContents: WebContents,
  method: 'Page.captureScreenshot' | 'Page.getLayoutMetrics',
  params: Record<string, unknown>
): Promise<T> | null {
  return startBrowserScreenshotOperation(
    webContents,
    () => webContents.debugger.sendCommand(method, params) as Promise<T>
  )
}

export function startBrowserFallbackCapture(
  webContents: WebContents
): Promise<Electron.NativeImage> | null {
  return startBrowserScreenshotOperation(webContents, () => webContents.capturePage())
}

export function resetBrowserScreenshotAdmissionForTests(): void {
  admissionEpoch += 1
  activeCaptures = 0
}
