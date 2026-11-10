/** Draws a hidden guest while a capture or agent input needs its frames; returns its release. */
export type CapturePaintHold = () => () => void

/**
 * Holds paint until Chromium answers the capture, not just while the caller waits. A capture stays
 * pending until the guest draws, and while pending it can hold macOS display sleep off ("Capturing");
 * timeouts and debugger detach do not cancel it (#24946).
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
