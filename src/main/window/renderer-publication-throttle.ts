export type RendererPublicationThrottleTarget = {
  isDestroyed?: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
}

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
      }
    }
  }
}
