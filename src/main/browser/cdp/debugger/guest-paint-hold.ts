import type { WebContents } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'

/** Draws a hidden guest while a capture or agent input needs its frames; returns its release. */
export type CapturePaintHold = () => () => void

function retainUntilSettled<T>(acquire: () => () => void, run: () => Promise<T>): Promise<T> {
  let release: () => void
  try {
    release = acquire()
  } catch (error) {
    return Promise.reject(error)
  }
  const pending = new Promise<T>((resolve) => resolve(run()))
  void pending.then(release, release)
  return pending
}

/**
 * Holds paint until Chromium answers the capture, not just while the caller waits. A capture stays
 * pending until the guest draws, and while pending it can hold macOS display sleep off ("Capturing");
 * timeouts do not cancel it (#24946).
 */
export function holdPaintUntilSettled<T>(
  holdPaint: CapturePaintHold,
  capture: () => Promise<T>
): Promise<T> {
  return retainUntilSettled(holdPaint, capture)
}

/** Also keeps the debugger attached: a detach rejects the command while Chromium keeps the capture. */
export function holdPaintUntilCdpCaptureSettles<T>(
  webContents: WebContents,
  holdPaint: CapturePaintHold,
  capture: () => Promise<T>
): Promise<T> {
  return retainUntilSettled(
    () => acquireElectronDebugger(webContents).release,
    () => retainUntilSettled(holdPaint, capture)
  )
}
