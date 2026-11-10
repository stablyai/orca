import type { WebContents } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'

/** Draws a hidden guest while a capture or agent input needs its frames; returns its release. */
export type CapturePaintHold = () => () => void

/**
 * Holds paint until Chromium answers the capture, not just while the caller waits. A capture stays
 * pending until the guest draws, and while pending it can hold macOS display sleep off ("Capturing");
 * timeouts do not cancel it (#24946).
 */
export function holdPaintUntilSettled<T>(
  holdPaint: CapturePaintHold,
  capture: () => Promise<T>
): Promise<T> {
  const release = holdPaint()
  let pending: Promise<T>
  try {
    pending = capture()
  } catch (error) {
    release()
    throw error
  }
  void pending.then(release, release)
  return pending
}

/** Also keeps the debugger attached: a detach rejects the command while Chromium keeps the capture. */
export function holdPaintUntilCdpCaptureSettles<T>(
  webContents: WebContents,
  holdPaint: CapturePaintHold,
  capture: () => Promise<T>
): Promise<T> {
  let debuggerLease: ReturnType<typeof acquireElectronDebugger>
  try {
    debuggerLease = acquireElectronDebugger(webContents)
  } catch (error) {
    return Promise.reject(error)
  }
  let pending: Promise<T>
  try {
    pending = holdPaintUntilSettled(holdPaint, capture)
  } catch (error) {
    debuggerLease.release()
    throw error
  }
  void pending.then(debuggerLease.release, debuggerLease.release)
  return pending
}
