export class RpcControlProbeFollowUp<T> {
  private active = false
  private queued: T | null = null

  constructor(
    private readonly getCurrentTarget: () => T | null,
    private readonly launch: (target: T) => void,
    private readonly onFinish: (hasQueuedFollowUp: boolean) => void = () => {}
  ) {}

  begin(target: T, queueAfterCurrent: boolean): boolean {
    if (!this.active) {
      this.active = true
      return true
    }
    if (queueAfterCurrent) {
      this.queued = target
    }
    return false
  }

  finish(target?: T): void {
    this.active = false
    const queued = this.queued
    this.queued = null
    const hasQueuedFollowUp =
      target !== undefined &&
      queued !== null &&
      queued === target &&
      this.getCurrentTarget() === queued
    this.onFinish(hasQueuedFollowUp)
    if (hasQueuedFollowUp && queued !== null) {
      queueMicrotask(() => this.launch(queued))
    }
  }
}
