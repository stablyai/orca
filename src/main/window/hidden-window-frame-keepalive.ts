/**
 * Windows composites nothing for a never-shown idle window, so CDP Page.captureScreenshot waits for a
 * frame forever (seen in session 0 under ORCA_BACKGROUND_LAUNCH=1). Repaint periodically until shown.
 */
type KeepaliveWindow = {
  isDestroyed(): boolean
  isVisible(): boolean
  once(event: 'show', listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
  webContents: { invalidate(): void; isDestroyed?(): boolean }
}

export const HIDDEN_WINDOW_FRAME_KEEPALIVE_MS = 750

export function installHiddenWindowFrameKeepalive(
  window: KeepaliveWindow,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): () => void {
  if (platform !== 'win32' || env.ORCA_BACKGROUND_LAUNCH !== '1' || window.isVisible()) {
    return () => {}
  }
  const stop = (): void => clearInterval(timer)
  const timer = setInterval(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed?.() === true) {
      stop()
      return
    }
    if (!window.isVisible()) {
      window.webContents.invalidate()
    }
  }, HIDDEN_WINDOW_FRAME_KEEPALIVE_MS)
  timer.unref?.()
  window.once('show', stop)
  window.once('closed', stop)
  return stop
}
