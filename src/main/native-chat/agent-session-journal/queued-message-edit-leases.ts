// In-memory edit leases for queued cards: while a person edits a card in place, automatic
// delivery stops at it (`nextSendableQueuedCard`). Nothing here is durable. Each lease dies on
// its own deadline, and every read re-derives validity from the card it holds, so a lost
// release, a send, a delete or another client's save never leaves a card held.

import type { AgentSessionQueuedMessageEditHoldResult } from '../../../shared/agent-session-wire'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

export const QUEUED_MESSAGE_EDIT_LEASE_MS = 120_000

type EditLeaseKey = { callerKey: string; editId: string }

type EditLease = Pick<QueuedMessageRow, 'messageId' | 'fingerprint' | 'state' | 'consumedAs'> & {
  until: number
}

/** One per journal handle: closing the conversation drops every lease with it. */
export class QueuedMessageEditLeases {
  private readonly leases = new Map<string, EditLease>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | null = null
  private wake: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly rows: () => readonly QueuedMessageRow[],
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Called once a deadline passes, so the queue re-derives with no other journal activity. */
  onDeadline(wake: () => void): void {
    this.wake = wake
  }

  /** Cards a live lease holds. `rows` is the caller's own read inside a transaction. */
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
      }
    }
    this.schedule()
    // A deadline pruned here before its timer ran: that timer is gone, so this wakes in its place.
    if (lapsed) {
      this.wake?.()
    }
    return new Set([...this.leases.values()].map((lease) => lease.messageId))
  }

  /** Idempotent per caller and edit: a repeat answers the same lease without extending it. */
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
    this.schedule()
    return this.answer(lease)
  }

  /** A lease that lapsed or lost its card is not revived: the editor acquires again. */
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

  /** Only the exact caller and edit release: never another editor's lease on the same card. */
  release(key: EditLeaseKey, messageId: string): void {
    if (this.leases.get(leaseKey(key))?.messageId === messageId) {
      this.leases.delete(leaseKey(key))
      this.schedule()
    }
  }

  /** A save changed the card: every lease on its old text is spent. */
  retire(messageId: string): void {
    for (const [key, lease] of this.leases) {
      if (lease.messageId === messageId) {
        this.leases.delete(key)
      }
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.leases.clear()
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

  /** One timer, at the nearest deadline; unchanged when that deadline is. */
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
          }
        }
        this.schedule()
        this.wake?.()
      },
      Math.max(1, next - this.now())
    )
    // Read untyped: this module also compiles into the phone's tests, where a timer is a number.
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

/** A hand-off or a return in between re-scopes the card even when its text is unchanged. */
function leaseMatchesRow(lease: EditLease, row: QueuedMessageRow): boolean {
  return (
    isUnsettledQueuedMessage(row) &&
    row.fingerprint === lease.fingerprint &&
    row.state === lease.state &&
    row.consumedAs === lease.consumedAs
  )
}
