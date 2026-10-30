// Ephemeral edit leases block automatic delivery; reads revalidate against deadlines and current cards.

import type { AgentSessionQueuedMessageEditHoldResult } from '../../../shared/agent-session-wire'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

export const QUEUED_MESSAGE_EDIT_LEASE_MS = 120_000

type EditLeaseKey = { callerKey: string; editId: string }

type EditLease = Pick<QueuedMessageRow, 'messageId' | 'fingerprint' | 'state' | 'consumedAs'> & {
  until: number
}

/** Closing the journal handle drops its leases. */
export class QueuedMessageEditLeases {
  private readonly leases = new Map<string, EditLease>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | null = null
  private wake: (() => void) | undefined
  private disposed = false
  private generation = 0

  revision(): number {
    return this.generation
  }

  constructor(
    private readonly rows: () => readonly QueuedMessageRow[],
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Wake the queue even when no journal activity follows expiry. */
  onDeadline(wake: () => void): void {
    this.wake = wake
  }

  /** Transaction callers supply their own card snapshot. */
  heldIds(rows: readonly QueuedMessageRow[] = this.rows()): ReadonlySet<string> {
    if (this.leases.size === 0) {
      return new Set()
    }
    const byId = new Map(rows.map((row) => [row.messageId, row]))
    const now = this.now()
    let lapsed = false
    for (const [key, lease] of this.leases) {
      const row = byId.get(lease.messageId)
      lapsed ||= lease.until <= now
      if (lease.until <= now || !row || !leaseMatchesRow(lease, row)) {
        this.leases.delete(key)
        this.generation++
      }
    }
    this.schedule()
    // A pruned deadline cancels its timer; wake in that timer's place.
    if (lapsed) {
      this.wake?.()
    }
    return new Set([...this.leases.values()].map((lease) => lease.messageId))
  }

  /** Repeated acquisition returns the same lease without extending it. */
  acquire(
    key: EditLeaseKey,
    input: { messageId: string; fingerprint: string }
  ): AgentSessionQueuedMessageEditHoldResult {
    this.heldIds()
    const existing = this.leases.get(leaseKey(key))
    if (existing) {
      return existing.messageId === input.messageId && existing.fingerprint === input.fingerprint
        ? this.answer(existing)
        : { status: 'changed' }
    }
    const row = this.rows().find((entry) => entry.messageId === input.messageId)
    if (this.disposed || !row || !isUnsettledQueuedMessage(row)) {
      return { status: 'gone' }
    }
    if (row.fingerprint !== input.fingerprint) {
      return { status: 'changed' }
    }
    const lease: EditLease = {
      messageId: row.messageId,
      fingerprint: row.fingerprint,
      state: row.state,
      consumedAs: row.consumedAs,
      until: this.now() + QUEUED_MESSAGE_EDIT_LEASE_MS
    }
    this.leases.set(leaseKey(key), lease)
    this.generation++
    this.schedule()
    return this.answer(lease)
  }

  /** Expired/invalidated editors must acquire a new lease. */
  renew(key: EditLeaseKey, messageId: string): AgentSessionQueuedMessageEditHoldResult {
    this.heldIds()
    const lease = this.leases.get(leaseKey(key))
    if (!lease || lease.messageId !== messageId) {
      return { status: 'expired' }
    }
    lease.until = this.now() + QUEUED_MESSAGE_EDIT_LEASE_MS
    this.schedule()
    return this.answer(lease)
  }

  /** Release only the exact caller/edit pair. */
  release(key: EditLeaseKey, messageId: string): void {
    if (this.leases.get(leaseKey(key))?.messageId === messageId) {
      this.leases.delete(leaseKey(key))
      this.generation++
      this.schedule()
    }
  }

  retire(messageId: string): void {
    for (const [key, lease] of this.leases) {
      if (lease.messageId === messageId) {
        this.leases.delete(key)
        this.generation++
      }
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.leases.clear()
    this.generation++
    this.schedule()
  }

  private answer(lease: EditLease): AgentSessionQueuedMessageEditHoldResult {
    return {
      status: 'held',
      fingerprint: lease.fingerprint,
      leaseDurationMs: QUEUED_MESSAGE_EDIT_LEASE_MS,
      remainingMs: Math.max(0, lease.until - this.now())
    }
  }

  private schedule(): void {
    const next =
      this.leases.size === 0 ? null : Math.min(...[...this.leases.values()].map((l) => l.until))
    if (next === this.timerAt) {
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = next
    if (next === null) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.timerAt = null
        const now = this.now()
        for (const [key, lease] of this.leases) {
          if (lease.until <= now) {
            this.leases.delete(key)
            this.generation++
          }
        }
        this.schedule()
        this.wake?.()
      },
      Math.max(1, next - this.now())
    )
    // Mobile test builds use numeric timers.
    const timer: unknown = this.timer
    if (
      typeof timer === 'object' &&
      timer &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }
}

function leaseKey(key: EditLeaseKey): string {
  return JSON.stringify([key.callerKey, key.editId])
}

/** Handoffs/returns invalidate leases even when text is unchanged. */
function leaseMatchesRow(lease: EditLease, row: QueuedMessageRow): boolean {
  return (
    isUnsettledQueuedMessage(row) &&
    row.fingerprint === lease.fingerprint &&
    row.state === lease.state &&
    row.consumedAs === lease.consumedAs
  )
}
