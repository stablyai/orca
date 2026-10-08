import type { WebContents } from 'electron'

/** Minimal surface the lease needs, so tests can run without Electron. */
export type OffscreenPaintLeaseWebContents = Pick<WebContents, 'id' | 'isDestroyed'> & {
  setBackgroundThrottling: (allowed: boolean) => void
  invalidate?: () => void
}

/**
 * Per-webContents refcount lease that lifts background throttling while any
 * consumer (screencast, screenshot, snapshot) needs live paint output.
 */
export class OffscreenPaintLease {
  private readonly refcounts = new Map<number, number>()

  acquire(webContents: OffscreenPaintLeaseWebContents): () => void {
    const webContentsId = webContents.id
    const first = (this.refcounts.get(webContentsId) ?? 0) === 0
    this.refcounts.set(webContentsId, (this.refcounts.get(webContentsId) ?? 0) + 1)
    if (first && !webContents.isDestroyed()) {
      webContents.setBackgroundThrottling(false)
      webContents.invalidate?.()
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.refcounts.get(webContentsId) ?? 1) - 1
      if (remaining <= 0) {
        this.refcounts.delete(webContentsId)
        if (!webContents.isDestroyed()) {
          webContents.setBackgroundThrottling(true)
        }
        return
      }
      this.refcounts.set(webContentsId, remaining)
    }
  }

  isHeld(webContentsId: number): boolean {
    return (this.refcounts.get(webContentsId) ?? 0) > 0
  }
}
