import type { MobileNotificationEvent } from './orca-runtime'

// Why: when a mobile client's socket is reaped (background/sleep, or a warm
// proxy that delays the heartbeat reap), notifications dispatched in that
// window are lost — there is no queue. This buffer is the catch-up source of
// truth on the desktop: every notification that flows through
// dispatchMobileNotification is recorded with a monotonic seq, and a reconnecting
// client asks for everything after the seq it last acknowledged.
//
// Idempotency (the adversarial-review gate for #8129): replay is keyed by a
// global monotonic seq, not by wall-clock. getMissedSince(lastSeenSeq) returns
// exactly the events with seq > lastSeenSeq. Re-requesting with the same
// watermark returns the same set; requesting with the client's true watermark
// can never return an already-delivered event. The client additionally tracks
// seen ids, so even a buffer-cap overlap cannot double-push.
//
// Why the field is `notificationSeq` (not `seq`): the live fan-out in
// dispatchMobileNotification tags each event with `notificationSeq`, and the
// mobile client watermarks + dedups on that exact field. Replayed events MUST
// carry the same field name or the client can't advance its watermark from a
// replay-only delivery (it would re-fetch/re-push across a restart). Keeping a
// single field name end-to-end is what makes live and replay interchangeable.
export type ReplayableMobileNotification = MobileNotificationEvent & {
  notificationSeq: number
}

// Why: bound the buffer. 256 completes a few minutes of real agent activity and
// tracks the client's existing MAX_SCHEDULED_NOTIFICATIONS (256) cap, far beyond
// any background window a reconnect can still salvage. Beyond the cap we evict
// oldest-first; a reconnect after that long is effectively a cold open and the
// live stream resumes from current, so dropping older entries is acceptable.
const DEFAULT_CAPACITY = 256

export class MobileNotificationReplayBuffer {
  private readonly capacity: number
  private seq = 0
  private readonly buffer: ReplayableMobileNotification[] = []

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity
  }

  // Records a dispatched event and returns the monotonic seq assigned to it.
  // Callers surface the seq so clients can watermark their last-seen position
  // (both on the live fan-out and on explicit catch-up requests).
  record(event: MobileNotificationEvent): number {
    const seq = ++this.seq
    this.buffer.push({ ...event, notificationSeq: seq })
    if (this.buffer.length > this.capacity) {
      // Why: insertion-order array; oldest entries sit at the front.
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    return seq
  }

  // Returns every recorded event with seq strictly greater than lastSeenSeq.
  // Because seq is monotonic and global, this is an exact, idempotent cut:
  // the same lastSeenSeq always yields the same result.
  getMissedSince(lastSeenSeq: number): ReplayableMobileNotification[] {
    if (lastSeenSeq >= this.seq) {
      return []
    }
    return this.buffer.filter((entry) => entry.notificationSeq > lastSeenSeq)
  }

  // Test/inspection helper: number of events currently retained.
  get size(): number {
    return this.buffer.length
  }
}
