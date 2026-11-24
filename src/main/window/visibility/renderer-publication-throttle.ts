import { occupyNativeCaptureLane, pendingNativeCapture } from './native-capture-lane'

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
  private readonly deferredRestores = new Set<RendererPublicationThrottleTarget>()
  private readonly observers = new Map<
    RendererPublicationThrottleTarget,
    Set<(leased: boolean) => void>
  >()

  /** Tells an owner when the target's first lease starts and its last one ends. */
  observe(
    target: RendererPublicationThrottleTarget,
    onChange: (leased: boolean) => void
  ): () => void {
    const observers = this.observers.get(target) ?? new Set()
    observers.add(onChange)
    this.observers.set(target, observers)
    return () => {
      observers.delete(onChange)
      if (observers.size === 0 && this.observers.get(target) === observers) {
        this.observers.delete(target)
      }
    }
  }

  acquire(target: RendererPublicationThrottleTarget): () => void {
    const pendingRestore = this.pendingRestores.get(target)
    if (pendingRestore !== undefined) {
      clearTimeout(pendingRestore)
      this.pendingRestores.delete(target)
    }
    const leaseCount = this.leasesByTarget.get(target) ?? 0
    if (leaseCount === 0) {
      target.setBackgroundThrottling(false)
      this.notify(target, true)
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
      this.notify(target, false)
      // Debugger detach drains promise callbacks inside native destruction, before isDestroyed flips.
      const restore = setTimeout(() => {
        this.pendingRestores.delete(target)
        this.restoreWhenCaptureLaneFree(target)
      }, 0)
      this.pendingRestores.set(target, restore)
    }
  }

  // A native capture still in flight (e.g. an abandoned Draw readback) must settle before the restore submits its own.
  private restoreWhenCaptureLaneFree(target: RendererPublicationThrottleTarget): void {
    if (this.leasesByTarget.has(target) || this.deferredRestores.has(target)) {
      return
    }
    const busy = pendingNativeCapture(target)
    if (busy) {
      this.deferredRestores.add(target)
      void busy.then(() => {
        this.deferredRestores.delete(target)
        this.restoreWhenCaptureLaneFree(target)
      })
      return
    }
    try {
      if (target.isDestroyed?.() === true) {
        return
      }
      target.setBackgroundThrottling(true)
      // Focused targets have no swallowed hide: embedder key status is lost under a cover.
      if (target.isFocused?.() !== true) {
        // Re-throttling cannot replay a swallowed hide; stayHidden capture completion can.
        occupyNativeCaptureLane(
          target,
          target.capturePage(REHIDE_CAPTURE_RECT, { stayHidden: true }).catch(() => {})
        )
      }
    } catch {
      // Native calls can also throw synchronously when the renderer is unavailable.
    }
  }

  private notify(target: RendererPublicationThrottleTarget, leased: boolean): void {
    for (const onChange of this.observers.get(target) ?? []) {
      onChange(leased)
    }
  }
}

// Share one process-wide owner so independent leases cannot re-throttle each other.
export const rendererPublicationThrottle = new RendererPublicationThrottle()
