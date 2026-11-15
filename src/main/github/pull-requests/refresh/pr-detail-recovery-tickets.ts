import { randomUUID } from 'node:crypto'
import {
  PR_DETAIL_RECOVERY_LEASE_MS,
  PR_DETAIL_RECOVERY_PREPARE_TTL_MS,
  PR_DETAIL_RECOVERY_RETENTION_MS,
  type PRDetailRecoveryCommitArgs,
  type PRDetailRecoveryNotAdmittedReason,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryStartArgs,
  type PRDetailRecoveryTerminal
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRegistration, PRRefreshRequestRegistry } from './pr-refresh-request-registry'
import {
  createPRDetailRecoveryTicket,
  prDetailRecoveryPredecessorOutstanding
} from './pr-detail-recovery-submission'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import { expirePRDetailRecoveryTickets } from './pr-detail-recovery-expiry'
import { PRDetailRecoveryStarts } from './pr-detail-recovery-starts'
import {
  bumpTicket,
  retireTicketGrant,
  recoveryQueueEntry,
  recoveryQueueKey,
  waitForTicketChange,
  snapshotTicket,
  type PRDetailRecoveryCaller,
  type PRDetailRecoveryTicket
} from './pr-detail-recovery-ticket-model'

type Deps = {
  queue: PRRefreshQueue
  requests: PRRefreshRequestRegistry
  retry: PRRefreshRetryState
  scheduleDrain: () => void
}

/** Queued detail-recovery tickets: correlated, one-shot reads owned by the PR refresh coordinator. */
export class PRDetailRecoveryTickets {
  private readonly tickets = new Map<string, PRDetailRecoveryTicket>()
  private readonly starts = new PRDetailRecoveryStarts({
    create: (start, candidate, acceptSequence) => {
      const ticket = createPRDetailRecoveryTicket(this.deps.queue, this.deps.requests, {
        caller: start.caller,
        args: start.args,
        candidate,
        epochKey: start.key,
        digest: start.digest,
        acceptSequence
      })
      this.tickets.set(ticket.ticketId, ticket)
      this.advance(ticket)
      this.deps.scheduleDrain()
      return ticket
    },
    revoke: (ticket) => this.revoke(ticket),
    schedule: () => this.deps.scheduleDrain()
  })
  private prepareSequence = 0

  constructor(private readonly deps: Deps) {}

  get(ticketId: string): PRDetailRecoveryTicket | undefined {
    return this.tickets.get(ticketId)
  }

  start(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs,
    resolved: GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason
  ): PRDetailRecoverySnapshot {
    return this.starts.start(caller, args, resolved)
  }

  startResolving(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs,
    resolve: () => Promise<GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason>
  ): Promise<PRDetailRecoverySnapshot> {
    return this.starts.startResolving(caller, args, resolve)
  }

  /** Move a ticket whose predecessors settled into the queue; never re-enqueue a closed one. */
  private advance(ticket: PRDetailRecoveryTicket): void {
    if (ticket.terminal || (ticket.phase !== 'waiting-existing' && ticket.phase !== 'queued')) {
      return
    }
    if (
      ticket.predecessors.some((p) =>
        prDetailRecoveryPredecessorOutstanding(this.deps.queue, this.deps.requests, ticket, p)
      )
    ) {
      return
    }
    const key = recoveryQueueKey(ticket.ticketId)
    if (this.deps.queue.get(key)) {
      return
    }
    const now = Date.now()
    // Recovery bypasses fresh-cache answers only; cooldown, error backoff and manual gates still hold.
    const dueAt = Math.max(
      now,
      this.deps.queue.backgroundUntil(ticket.slotKey),
      this.deps.retry.manualGateUntil(ticket.slotKey)
    )
    ticket.phase = dueAt > now ? 'paused' : 'queued'
    ticket.notBefore = dueAt > now ? dueAt : undefined
    this.deps.queue.set(key, recoveryQueueEntry(ticket, dueAt, false))
    bumpTicket(ticket)
    // Settlement observed off the drainer (direct or hosted reads) must still wake it; future gates keep their dueAt.
    this.deps.scheduleDrain()
  }

  /** Queue or read settlement: wake predecessor waiters and close orphaned queued tickets. */
  recheck(): void {
    for (const ticket of this.tickets.values()) {
      if (ticket.terminal) {
        continue
      }
      if (ticket.phase === 'waiting-existing') {
        this.advance(ticket)
        continue
      }
      const queued = this.deps.queue.get(recoveryQueueKey(ticket.ticketId))
      if ((ticket.phase === 'queued' || ticket.phase === 'paused') && !queued) {
        this.close(ticket, { kind: 'not-admitted', reason: 'unregistered' })
      }
    }
  }

  /** Later independent work for this alias wins: before admission the ticket closes, after it the read loses publication. */
  onRegistration(registration: PRRefreshRegistration): void {
    if (!registration.independent) {
      return
    }
    for (const ticket of this.tickets.values()) {
      if (
        !ticket.terminal &&
        ticket.slotKey === registration.slotKey &&
        registration.registrationOrder > ticket.acceptOrder &&
        registration.aliases.some((alias) => alias.cacheKey === ticket.alias.cacheKey)
      ) {
        this.close(ticket, { kind: 'superseded' })
      }
    }
  }

  prepare(ticket: PRDetailRecoveryTicket): void {
    this.deps.queue.delete(recoveryQueueKey(ticket.ticketId))
    this.prepareSequence += 1
    retireTicketGrant(ticket)
    ticket.phase = 'preparing'
    ticket.notBefore = undefined
    ticket.preparation = {
      token: randomUUID(),
      expiresAt: Date.now() + PR_DETAIL_RECOVERY_PREPARE_TTL_MS,
      prepareSequence: this.prepareSequence
    }
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  /** A gate moved before dispatch: retire the token and its grant, then prepare again after the gate. */
  pause(ticket: PRDetailRecoveryTicket, until: number): void {
    const key = recoveryQueueKey(ticket.ticketId)
    const entry = this.deps.queue.get(key)
    if (entry) {
      entry.dueAt = until
      if (entry.recovery) {
        entry.recovery.committed = false
      }
    }
    ticket.phase = 'paused'
    ticket.notBefore = until
    retireTicketGrant(ticket)
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  commit(callerKey: string, args: PRDetailRecoveryCommitArgs): PRDetailRecoverySnapshot | null {
    const ticket = this.owned(callerKey, args.ticketId)
    if (!ticket) {
      return null
    }
    this.renew(ticket)
    if (ticket.committedToken === args.prepareToken) {
      return snapshotTicket(ticket)
    }
    const preparation = ticket.preparation
    if (
      ticket.terminal ||
      ticket.phase !== 'preparing' ||
      !preparation ||
      preparation.token !== args.prepareToken ||
      preparation.expiresAt <= Date.now()
    ) {
      return snapshotTicket(ticket)
    }
    ticket.committedToken = args.prepareToken
    ticket.publicationGrantId = args.publicationGrantId
    // Committed work waits in the queue under ordinary pacing; the preparation deadline no longer applies.
    ticket.phase = 'queued'
    const key = recoveryQueueKey(ticket.ticketId)
    this.deps.queue.set(key, recoveryQueueEntry(ticket, Date.now(), true))
    bumpTicket(ticket)
    this.deps.scheduleDrain()
    return snapshotTicket(ticket)
  }

  close(ticket: PRDetailRecoveryTicket, terminal: PRDetailRecoveryTerminal): void {
    if (ticket.terminal) {
      return
    }
    ticket.phase = 'terminal'
    ticket.terminal = terminal
    ticket.preparation = undefined
    ticket.retainUntil = Date.now() + PR_DETAIL_RECOVERY_RETENTION_MS
    if (!ticket.admitted) {
      this.deps.queue.delete(recoveryQueueKey(ticket.ticketId))
    }
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  cancel(callerKey: string, ticketId: string): PRDetailRecoverySnapshot | null {
    const ticket = this.owned(callerKey, ticketId)
    if (!ticket) {
      return null
    }
    this.close(ticket, { kind: 'cancelled' })
    return snapshotTicket(ticket)
  }

  private revoke(ticket: PRDetailRecoveryTicket): void {
    // Even a settled outcome that has not been delivered loses its grant on revocation.
    ticket.terminal = undefined
    retireTicketGrant(ticket)
    this.close(ticket, { kind: 'cancelled' })
  }

  cancelCaller(callerKey: string): void {
    this.starts.cancelCaller(callerKey)
  }

  private forget(ticket: PRDetailRecoveryTicket): void {
    this.tickets.delete(ticket.ticketId)
    this.starts.forgetTicket(ticket)
  }

  /** Bounded observation; it never enqueues, admits or reads. */
  async wait(
    callerKey: string,
    ticketId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<PRDetailRecoverySnapshot | null> {
    const ticket = this.owned(callerKey, ticketId)
    if (!ticket) {
      return null
    }
    this.renew(ticket)
    if (ticket.revision > afterRevision || ticket.terminal) {
      return snapshotTicket(ticket)
    }
    await waitForTicketChange(ticket, signal)
    this.renew(ticket)
    return snapshotTicket(ticket)
  }

  /** Expire leases, preparations, settlement budgets and retention; returns the next deadline. */
  tick(now = Date.now()): number | null {
    const pending = this.starts.tick(now)
    const tickets = expirePRDetailRecoveryTickets(this.tickets.values(), now, this.deps.queue, {
      close: (ticket, terminal) => this.close(ticket, terminal),
      forget: (ticket) => this.forget(ticket)
    })
    const next = Math.min(pending ?? Infinity, tickets ?? Infinity)
    return Number.isFinite(next) ? next : null
  }

  private owned(callerKey: string, ticketId: string): PRDetailRecoveryTicket | undefined {
    const ticket = this.tickets.get(ticketId)
    if (ticket?.caller.callerKey !== callerKey) {
      return undefined
    }
    if (ticket.caller.authority?.signal.aborted) {
      this.revoke(ticket)
    }
    return ticket
  }

  private renew(ticket: PRDetailRecoveryTicket): void {
    if (!ticket.terminal) {
      ticket.leaseUntil = Date.now() + PR_DETAIL_RECOVERY_LEASE_MS
    }
  }
}
