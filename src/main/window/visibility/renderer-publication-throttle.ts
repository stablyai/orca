import {
  isNativeCaptureBusy,
  occupyNativeCaptureLane,
  whenNativeCaptureLaneFree
} from './native-capture-lane'

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
  // Weak, so an owed rehide never keeps a destroyed target alive.
  private readonly owedRehides = new WeakMap<
    RendererPublicationThrottleTarget,
    { cancel: () => void }
  >()
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
    // A held lease postpones any owed rehide until its own release.
    this.dropRehide(target)
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
        this.restore(target)
      }, 0)
      this.pendingRestores.set(target, restore)
    }
  }

  private restore(target: RendererPublicationThrottleTarget): void {
    if (this.leasesByTarget.has(target)) {
      return
    }
    try {
      if (target.isDestroyed?.() === true) {
        return
      }
      // Re-throttle at once, even while a native capture (e.g. an abandoned Draw readback) is pending.
      target.setBackgroundThrottling(true)
      // Focused targets have no swallowed hide: embedder key status is lost under a cover.
      if (target.isFocused?.() !== true) {
        this.oweRehide(target)
      }
    } catch {
      // Native calls can also throw synchronously when the renderer is unavailable.
    }
  }

  // One rehide obligation per target: it waits for an in-flight capture, and a new lease cancels it.
  private oweRehide(target: RendererPublicationThrottleTarget): void {
    this.dropRehide(target)
    const owed = { cancel: () => {} }
    this.owedRehides.set(target, owed)
    const submit = (): void => {
      if (this.owedRehides.get(target) !== owed) {
        return
      }
      if (isNativeCaptureBusy(target)) {
        owed.cancel = whenNativeCaptureLaneFree(target, submit)
        return
      }
      this.owedRehides.delete(target)
      try {
        if (target.isDestroyed?.() === true || this.leasesByTarget.has(target)) {
          return
        }
        // Re-throttling cannot replay a swallowed hide; stayHidden capture completion can.
        occupyNativeCaptureLane(
          target,
          target.capturePage(REHIDE_CAPTURE_RECT, { stayHidden: true }).catch(() => {})
        )
      } catch {
        // Native calls can also throw synchronously when the renderer is unavailable.
      }
    }
    submit()
  }

  private dropRehide(target: RendererPublicationThrottleTarget): void {
    const owed = this.owedRehides.get(target)
    if (owed) {
      owed.cancel()
      this.owedRehides.delete(target)
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
