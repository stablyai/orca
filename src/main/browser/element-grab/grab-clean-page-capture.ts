import type { BrowserCleanPageCapture } from '../../../shared/browser/element-grab/browser-grab-clean-capture'

/** A cancelled capture settles at once; its late bytes are dropped rather than handed to Draw. */
export async function captureCleanGuestPage(
  guest: Electron.WebContents,
  signal: AbortSignal,
  holdPaint: () => () => void
): Promise<BrowserCleanPageCapture | null> {
  if (signal.aborted || guest.isDestroyed()) {
    return null
  }
  const releasePaint = holdPaint()
  let stop: () => void = () => {}
  try {
    const aborted = new Promise<null>((resolve) => {
      const abort = (): void => resolve(null)
      signal.addEventListener('abort', abort, { once: true })
      stop = () => signal.removeEventListener('abort', abort)
    })
    const image = await Promise.race([guest.capturePage().catch(() => null), aborted])
    if (!image || image.isEmpty() || signal.aborted || guest.isDestroyed()) {
      return null
    }
    return { dataUrl: image.toDataURL(), ...image.getSize() }
  } catch {
    return null
  } finally {
    stop()
    releasePaint()
  }
}
