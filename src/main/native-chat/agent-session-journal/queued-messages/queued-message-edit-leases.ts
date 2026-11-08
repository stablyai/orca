// Ephemeral edit leases block automatic delivery; reads revalidate against deadlines and current cards.

import type { AgentSessionQueuedMessageEditHoldResult } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

export const QUEUED_MESSAGE_EDIT_LEASE_MS = 120_000

export type EditLeaseKey = { callerKey: string; editId: string }

export type QueuedMessageEditLease = Pick<
  QueuedMessageRow,
  'messageId' | 'fingerprint' | 'state' | 'consumedAs'
>

type EditLease = QueuedMessageEditLease & {
  until: number
}

/** Closing the journal handle drops its leases. */
export class QueuedMessageEditLeases {
  private readonly leases = new Map<string, EditLease>()
  private readonly byId = new Map<string, Set<string>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | null = null
  private wake: (() => void) | undefined
  private disposed = false
  private revision = 0

  constructor(
    private readonly rows?: () => readonly QueuedMessageRow[],
    private readonly now: () => number = () => performance.now(),
    private readonly get?: (id: string) => QueuedMessageRow | null | undefined
  ) {}

  /** Wake the queue even when no journal activity follows expiry. */
  onDeadline(wake: () => void): void {
    this.wake = wake
  }

  version(): number {
    this.expire()
    return this.revision
  }

  isHeld(messageId: string, rows?: readonly QueuedMessageRow[]): boolean {
    this.expire()
    if (!this.byId.has(messageId)) {
      return false
    }
    const revision = this.revision
    const row = this.row(messageId, rows)
    for (const key of this.byId.get(messageId) ?? []) {
      const lease = this.leases.get(key)!
      if (!row || !leaseMatchesRow(lease, row)) {
        this.remove(key)
      }
    }
    if (this.revision !== revision) {
      this.schedule()
    }
    return this.byId.has(messageId)
  }

  /** Output enumeration revalidates only leased identities; selection uses exact-ID reads. */
  heldIds(rows?: readonly QueuedMessageRow[]): ReadonlySet<string> {
    this.expire()
    const snapshot = rows && new Map(rows.map((row) => [row.messageId, row]))
    for (const [key, lease] of this.leases) {
      const row = snapshot ? snapshot.get(lease.messageId) : this.row(lease.messageId)
      if (!row || !leaseMatchesRow(lease, row)) {
        this.remove(key)
      }
    }
    this.schedule()
    return new Set(this.byId.keys())
  }

  /** SQL validates these finite live identities against its own selected cards. */
  snapshot(): QueuedMessageEditLease[] {
    this.expire()
    return [...this.leases.values()].map(({ until: _until, ...lease }) => ({ ...lease }))
  }

  private row(messageId: string, rows?: readonly QueuedMessageRow[]) {
    return rows
      ? rows.find((row) => row.messageId === messageId)
      : this.get
        ? this.get(messageId)
        : this.rows?.().find((row) => row.messageId === messageId)
  }

  private remove(key: string): void {
    const lease = this.leases.get(key)
    if (!lease) {
      return
    }
    this.leases.delete(key)
    const keys = this.byId.get(lease.messageId)!
    keys.delete(key)
    if (keys.size === 0) {
      this.byId.delete(lease.messageId)
    }
    this.revision++
  }

  private expire(): void {
    if (this.timerAt === null || this.timerAt > this.now()) {
      return
    }
    const now = this.now()
    for (const [key, lease] of this.leases) {
      if (lease.until <= now) {
        this.remove(key)
      }
    }
    this.schedule()
    this.wake?.()
  }

  /** Repeated acquisition returns the same lease without extending it. */
  acquire(
    key: EditLeaseKey,
    input: { messageId: string; fingerprint: string },
    rows?: readonly QueuedMessageRow[]
  ): AgentSessionQueuedMessageEditHoldResult {
    this.expire()
    this.isHeld(this.leases.get(leaseKey(key))?.messageId ?? input.messageId, rows)
    const existing = this.leases.get(leaseKey(key))
    if (existing) {
      return existing.messageId === input.messageId && existing.fingerprint === input.fingerprint
        ? this.answer(existing)
        : { status: 'changed' }
    }
    const row = this.row(input.messageId, rows)
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
    const keys = this.byId.get(lease.messageId) ?? new Set<string>()
    keys.add(leaseKey(key))
    this.byId.set(lease.messageId, keys)
    this.revision++
    this.schedule()
    return this.answer(lease)
  }

  /** Expired/invalidated editors must acquire a new lease. */
  renew(
    key: EditLeaseKey,
    messageId: string,
    rows?: readonly QueuedMessageRow[]
  ): AgentSessionQueuedMessageEditHoldResult {
    this.isHeld(messageId, rows)
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
      this.remove(leaseKey(key))
      this.schedule()
    }
  }

  retire(messageId: string): void {
    for (const key of this.byId.get(messageId) ?? []) {
      this.remove(key)
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.leases.clear()
    this.byId.clear()
    this.revision++
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
            this.remove(key)
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
export function leaseMatchesRow(lease: QueuedMessageEditLease, row: QueuedMessageRow): boolean {
  return (
    isUnsettledQueuedMessage(row) &&
    row.fingerprint === lease.fingerprint &&
    row.state === lease.state &&
    row.consumedAs === lease.consumedAs
  )
}

export function queuedMessageEditLeaseHolds(leases: readonly QueuedMessageEditLease[]) {
  const byId = new Map<string, QueuedMessageEditLease[]>()
  for (const lease of leases) {
    const group = byId.get(lease.messageId) ?? []
    group.push(lease)
    byId.set(lease.messageId, group)
  }
  return (row: QueuedMessageRow | null): boolean =>
    row !== null && byId.get(row.messageId)?.some((lease) => leaseMatchesRow(lease, row)) === true
}
