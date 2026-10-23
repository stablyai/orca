import type { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'
import {
  CANARY_STALL_BACKOFF_INITIAL_MS,
  CANARY_STALL_BACKOFF_MAX_MS,
  type WatcherDeliveryHealth
} from './parcel-watcher-delivery-canary'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

/**
 * Host side of the child's canary health reports. Why: during an OS event
 * stall the child keeps its streams, so subscriptions would go silently stale.
 * Once a stall outlasts one canary backoff period, every caller gets an
 * overflow (rescan), backing off like the canary so a stalled system is not
 * loaded further, and one more when the stall ends.
 */
export class WatcherDeliveryHealthMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stalled = false
  // Only the current, non-disposed child's reports count.
  private active = false

  constructor(
    private readonly records: Map<number, WatcherProcessSubscriptionRecord>,
    private readonly crashFuse: WatcherProcessCrashFuse
  ) {}

  childStarted(): void {
    this.reset()
    this.active = true
    this.crashFuse.noteChildStarted()
  }

  update(state: WatcherDeliveryHealth): void {
    if (!this.active) {
      return
    }
    this.crashFuse.recordDeliveryHealth(state)
    if (state === 'stalled') {
      if (!this.stalled) {
        this.stalled = true
        this.schedule(CANARY_STALL_BACKOFF_INITIAL_MS)
      }
      return
    }
    // 'healthy' or 'unknown' (canary disarmed): either way the stall is over.
    if (this.stalled) {
      this.reset()
      this.rescanLive()
    }
  }

  /** The child is gone; crash recovery resyncs records through onInterruption. */
  reset(): void {
    this.stalled = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.reset()
    this.active = false
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.rescanLive() === 0) {
        this.reset()
        return
      }
      this.schedule(Math.min(delayMs * 2, CANARY_STALL_BACKOFF_MAX_MS))
    }, delayMs)
    this.timer.unref?.()
  }

  private rescanLive(): number {
    const live = Array.from(this.records.values()).filter(
      (record) => !record.pendingSubscribe && !record.interrupted
    )
    for (const record of live) {
      record.hooks.onOverflow?.()
    }
    return live.length
  }
}
