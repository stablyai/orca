import type { PRDetailRecoveryTerminal } from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { PRRefreshQueue } from './pr-refresh-queue'
import { recoveryQueueKey, type PRDetailRecoveryTicket } from './pr-detail-recovery-ticket-model'

function nextDeadline(ticket: PRDetailRecoveryTicket, queue: PRRefreshQueue, now: number): number {
  if (ticket.terminal) {
    return ticket.retainUntil ?? Number.POSITIVE_INFINITY
  }
  // A due entry is the drainer's own pacing work; only a future gate needs this wake.
  const dueAt = queue.get(recoveryQueueKey(ticket.ticketId))?.dueAt
  return Math.min(
    ticket.leaseUntil,
    ticket.phase === 'preparing'
      ? (ticket.preparation?.expiresAt ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY,
    ticket.settleDeadline ?? Number.POSITIVE_INFINITY,
    dueAt !== undefined && dueAt > now ? dueAt : Number.POSITIVE_INFINITY
  )
}

/** Runs on the drainer's one timer, before its busy guard, so a hung read cannot hold a deadline. */
export function expirePRDetailRecoveryTickets(
  tickets: Iterable<PRDetailRecoveryTicket>,
  now: number,
  queue: PRRefreshQueue,
  actions: {
    close: (ticket: PRDetailRecoveryTicket, terminal: PRDetailRecoveryTerminal) => void
    forget: (ticket: PRDetailRecoveryTicket) => void
  }
): number | null {
  let next = Number.POSITIVE_INFINITY
  for (const ticket of Array.from(tickets)) {
    if (ticket.terminal && (ticket.retainUntil ?? 0) <= now) {
      actions.forget(ticket)
      continue
    }
    if (!ticket.terminal) {
      if (ticket.leaseUntil <= now) {
        actions.close(ticket, { kind: 'expired' })
      } else if (
        ticket.phase === 'preparing' &&
        ticket.preparation &&
        ticket.preparation.expiresAt <= now
      ) {
        actions.close(ticket, { kind: 'not-admitted', reason: 'prepare-expired' })
      } else if (ticket.settleDeadline !== undefined && ticket.settleDeadline <= now) {
        // The underlying read keeps its drainer slot; only this ticket's publication ends.
        actions.close(ticket, { kind: 'timeout' })
      }
    }
    next = Math.min(next, nextDeadline(ticket, queue, now))
  }
  return Number.isFinite(next) ? next : null
}
