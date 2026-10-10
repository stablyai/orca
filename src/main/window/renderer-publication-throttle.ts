export type RendererPublicationThrottleTarget = {
  isDestroyed?: () => boolean
  isFocused?: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
  capturePage: (
    rect: { x: number; y: number; width: number; height: number },
    opts: { stayHidden: boolean }
  ) => Promise<unknown>
}

// Why: an empty rect sets no capture-size hint, which could resize a hidden view (DCHECKed for stayHidden).
const REHIDE_CAPTURE_RECT = { x: 0, y: 0, width: 0, height: 0 }

export class RendererPublicationThrottle {
  private readonly leasesByTarget = new Map<RendererPublicationThrottleTarget, number>()

  acquire(target: RendererPublicationThrottleTarget): () => void {
    const leaseCount = this.leasesByTarget.get(target) ?? 0
    if (leaseCount === 0) {
      target.setBackgroundThrottling(false)
    }
    this.leasesByTarget.set(target, leaseCount + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.leasesByTarget.get(target) ?? 1) - 1
      if (remaining > 0) {
        this.leasesByTarget.set(target, remaining)
        return
      }
      this.leasesByTarget.delete(target)
      if (target.isDestroyed?.() !== true) {
        target.setBackgroundThrottling(true)
        // Why: isFocused needs the (embedder's) window to be key, which a cover takes, so a focused target has no swallowed hide.
        if (target.isFocused?.() !== true) {
          // Why: re-throttling never replays a hide swallowed while leased; a stayHidden capture's completion does.
          target.capturePage(REHIDE_CAPTURE_RECT, { stayHidden: true }).catch(() => {})
        }
      }
    }
  }
}

// Why: one instance per process, or two owners of the same window would re-throttle it under each other's lease.
export const rendererPublicationThrottle = new RendererPublicationThrottle()
