import { randomUUID } from 'node:crypto'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { RetainedAgentAttention } from '../../../../shared/notifications/notification-settings-types'

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
  private readonly retained = new Map<string, ReplayableMobileNotification>()
  private readonly acknowledgedNotices = new Map<string, string>()
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
    const entry = { ...event, notificationSeq: seq, notificationEpoch: this.epochId }
    this.buffer.push(entry)
    if (event.notificationId) {
      if (event.type === 'notification' && event.notificationId.startsWith('orchestration-mail:')) {
        this.retained.set(event.notificationId, entry)
      } else if (event.type === 'dismiss') {
        this.retained.delete(event.notificationId)
      }
    }
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
    return seq
  }

  // Return retained events above the watermark; a different epoch invalidates it and returns the whole buffer.
  // Missing epochs preserve the seq-only cut for older clients; eviction can shorten repeated results.
  getMissedSince(lastSeenSeq: number, epoch?: string): ReplayableMobileNotification[] {
    const missed = this.buffer.filter(
      (entry) =>
        (epoch !== undefined && epoch !== this.epochId) || entry.notificationSeq > lastSeenSeq
    )
    const current = missed.filter(
      (entry) =>
        entry.type !== 'notification' ||
        !entry.notificationId?.startsWith('orchestration-mail:') ||
        this.retained.get(entry.notificationId ?? '')?.notificationSeq === entry.notificationSeq
    )
    const sequences = new Set(current.map((entry) => entry.notificationSeq))
    return [
      ...current,
      ...[...this.retained.values()].filter(
        (entry) =>
          !sequences.has(entry.notificationSeq) &&
          ((epoch !== undefined && epoch !== this.epochId) || entry.notificationSeq > lastSeenSeq)
      )
    ].sort((a, b) => a.notificationSeq - b.notificationSeq)
  }

  /** Agent notices still retained, as a newly subscribed desktop presents them. */
  retainedAgentAttention(): RetainedAgentAttention[] {
    return [...this.retained.values()].flatMap((event) =>
      event.type === 'notification' && event.notificationId
        ? [
            {
              notificationId: event.notificationId,
              title: event.title,
              body: event.body,
              worktreeId: event.worktreeId,
              paneKey: event.paneKey
            }
          ]
        : []
    )
  }

  retainedNotification(id: string): ReplayableMobileNotification | undefined {
    return this.retained.get(id)
  }

  /** The user saw this mail notice: stop replaying it, while its mail stays pending. */
  acknowledge(notice: ReplayableMobileNotification & { type: 'notification' }): void {
    this.acknowledgedNotices.set(notice.notificationId ?? '', noticeContent(notice))
  }

  /** Whether a reconciled notice is the one already dismissed; a changed or cleared notice forgets it. */
  acknowledged(id: string, notice: { title: string; body?: string } | null): boolean {
    const same = notice !== null && this.acknowledgedNotices.get(id) === noticeContent(notice)
    if (!same) {
      this.acknowledgedNotices.delete(id)
    }
    return same
  }

  get size(): number {
    return this.buffer.length
  }
}

function noticeContent(notice: { title: string; body?: string }): string {
  return JSON.stringify([notice.title, notice.body ?? ''])
}
