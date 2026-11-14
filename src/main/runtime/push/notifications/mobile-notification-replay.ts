import { randomUUID } from 'node:crypto'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'

// Buffer missed mobile notifications; notificationSeq must match live fan-out for client watermarks/dedup.
export type ReplayableMobileNotification = MobileNotificationEvent & {
  notificationSeq: number
  // Identify the counter lifetime so persisted watermarks survive desktop restarts.
  notificationEpoch: string
}

// Match the client 256-notification cap; longer gaps resume cold from retained/live events.
const DEFAULT_CAPACITY = 256

export class MobileNotificationReplayBuffer {
  private readonly capacity: number
  private seq = 0
  private readonly buffer: ReplayableMobileNotification[] = []
  // Persisted client watermarks can exceed a restarted counter; an epoch invalidates that stale position.
  private readonly epochId: string = randomUUID()

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity
  }

  get epoch(): string {
    return this.epochId
  }

  record(event: MobileNotificationEvent): number {
    const seq = ++this.seq
    this.buffer.push({ ...event, notificationSeq: seq, notificationEpoch: this.epochId })
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    return seq
  }

  // Return retained events above the watermark; a different epoch invalidates it and returns the whole buffer.
  // Missing epochs preserve the seq-only cut for older clients; eviction can shorten repeated results.
  getMissedSince(lastSeenSeq: number, epoch?: string): ReplayableMobileNotification[] {
    if (epoch !== undefined && epoch !== this.epochId) {
      return [...this.buffer]
    }
    if (lastSeenSeq >= this.seq) {
      return []
    }
    return this.buffer.filter((entry) => entry.notificationSeq > lastSeenSeq)
  }

  get size(): number {
    return this.buffer.length
  }
}
