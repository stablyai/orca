export type RendererPublicationThrottleTarget = {
  isDestroyed?: () => boolean
  isFocused?: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
  capturePage: (
    rect: { x: number; y: number; width: number; height: number },
    opts: { stayHidden: boolean }
  ) => Promise<unknown>
}

// Empty capture rect avoids a size hint that could resize hidden views (stayHidden DCHECK).
const REHIDE_CAPTURE_RECT = { x: 0, y: 0, width: 0, height: 0 }

export class RendererPublicationThrottle {
  private readonly leasesByTarget = new Map<RendererPublicationThrottleTarget, number>()
  private readonly pendingRestores = new Map<
    RendererPublicationThrottleTarget,
    ReturnType<typeof setTimeout>
  >()

  acquire(target: RendererPublicationThrottleTarget): () => void {
    const pendingRestore = this.pendingRestores.get(target)
    if (pendingRestore !== undefined) {
      clearTimeout(pendingRestore)
      this.pendingRestores.delete(target)
    }
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
      // Debugger detach drains promise callbacks inside native destruction, before isDestroyed flips.
      const restore = setTimeout(() => {
        this.pendingRestores.delete(target)
        try {
          if (target.isDestroyed?.() === true) {
            return
          }
          target.setBackgroundThrottling(true)
          // Focused targets have no swallowed hide: embedder key status is lost under a cover.
          if (target.isFocused?.() !== true) {
            // Re-throttling cannot replay a swallowed hide; stayHidden capture completion can.
            target.capturePage(REHIDE_CAPTURE_RECT, { stayHidden: true }).catch(() => {})
          }
        } catch {
          // Native calls can also throw synchronously when the renderer is unavailable.
        }
      }, 0)
      this.pendingRestores.set(target, restore)
    }
  }
}

// Share one process-wide owner so independent leases cannot re-throttle each other.
export const rendererPublicationThrottle = new RendererPublicationThrottle()
