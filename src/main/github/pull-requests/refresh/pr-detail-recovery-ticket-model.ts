import { randomUUID } from 'node:crypto'
import {
  PR_DETAIL_RECOVERY_WAIT_MAX_MS,
  type PRDetailRecoveryIdentity,
  type PRDetailRecoveryPhase,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryTerminal
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshQueueEntry } from './pr-refresh-queue'

/** Host restart invalidates every ticket id and source proof. */
export const PR_DETAIL_RECOVERY_HOST_INSTANCE = randomUUID()

/** Who owns a ticket: a native window or an authenticated runtime client. */
export type PRDetailRecoveryCaller = {
  callerKey: string
  windowId?: number
  pacingScope?: string
}

export type PRDetailRecoveryTicket = {
  ticketId: string
  caller: PRDetailRecoveryCaller
  epochKey: string
  counter: number
  identity: PRDetailRecoveryIdentity
  digest: string
  candidate: GitHubPRRefreshCandidate
  alias: GitHubPRRefreshAlias
  slotKey: string
  acceptSequence: number
  acceptOrder: number
  predecessors: PRDetailRecoverySnapshot['predecessors']
  revision: number
  phase: PRDetailRecoveryPhase
  admitted: boolean
  notBefore?: number
  preparation?: { token: string; expiresAt: number; prepareSequence: number }
  committedToken?: string
  publicationGrantId?: string
  requestSequence?: number
  requestStartedAt?: number
  settleDeadline?: number
  terminal?: PRDetailRecoveryTerminal
  leaseUntil: number
  retainUntil?: number
  waiters: Set<() => void>
}

export function recoveryQueueKey(ticketId: string): string {
  return `recovery::${ticketId}`
}

/** Ticket work enters the shared queue as paced active work under its own key, never the slot's. */
export function recoveryQueueEntry(
  ticket: PRDetailRecoveryTicket,
  dueAt: number,
  committed: boolean
): PRRefreshQueueEntry {
  const key = recoveryQueueKey(ticket.ticketId)
  return {
    key,
    candidate: ticket.candidate,
    aliases: new Map([[ticket.alias.cacheKey, ticket.alias]]),
    reason: 'active',
    priority: 80,
    dueAt,
    queuedAt: ticket.acceptOrder,
    windowId: ticket.caller.windowId,
    pacingScope: ticket.caller.pacingScope,
    recovery: { ticketId: ticket.ticketId, slotKey: ticket.slotKey, committed }
  }
}

export function snapshotTicket(ticket: PRDetailRecoveryTicket): PRDetailRecoverySnapshot {
  return {
    ticketId: ticket.ticketId,
    hostInstance: PR_DETAIL_RECOVERY_HOST_INSTANCE,
    identity: ticket.identity,
    revision: ticket.revision,
    acceptSequence: ticket.acceptSequence,
    predecessors: ticket.predecessors,
    ...(ticket.preparation ? { preparation: ticket.preparation } : {}),
    ...(ticket.publicationGrantId ? { publicationGrantId: ticket.publicationGrantId } : {}),
    phase: ticket.phase,
    admitted: ticket.admitted,
    ...(ticket.notBefore !== undefined ? { notBefore: ticket.notBefore } : {}),
    ...(ticket.requestSequence !== undefined ? { requestSequence: ticket.requestSequence } : {}),
    ...(ticket.requestStartedAt !== undefined ? { requestStartedAt: ticket.requestStartedAt } : {}),
    ...(ticket.terminal ? { terminal: ticket.terminal } : {})
  }
}

/** A refused submission that never became a ticket: nothing to observe, cancel or retain. */
export function refusedSnapshot(
  identity: PRDetailRecoveryIdentity,
  terminal: PRDetailRecoveryTerminal
): PRDetailRecoverySnapshot {
  return {
    ticketId: '',
    hostInstance: PR_DETAIL_RECOVERY_HOST_INSTANCE,
    identity,
    revision: 0,
    acceptSequence: 0,
    predecessors: [],
    phase: 'terminal',
    admitted: false,
    terminal
  }
}

export function bumpTicket(ticket: PRDetailRecoveryTicket): void {
  ticket.revision += 1
  const waiters = Array.from(ticket.waiters)
  ticket.waiters.clear()
  for (const wake of waiters) {
    wake()
  }
}

/** Bounded observation: resolves on the next revision, abort, or the wait deadline. */
export function waitForTicketChange(
  ticket: PRDetailRecoveryTicket,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      ticket.waiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, PR_DETAIL_RECOVERY_WAIT_MAX_MS)
    signal?.addEventListener('abort', done, { once: true })
    ticket.waiters.add(done)
  })
}

/** Retire a preparation and its unused grant; a later preparation issues fresh ones. */
export function retireTicketGrant(ticket: PRDetailRecoveryTicket): void {
  ticket.preparation = undefined
  ticket.committedToken = undefined
  ticket.publicationGrantId = undefined
}

/** The read crossed every gate and starts now; the settlement budget runs from here. */
export function admitTicket(
  ticket: PRDetailRecoveryTicket,
  requestSequence: number,
  settleDeadline: number
): void {
  ticket.phase = 'admitted'
  ticket.admitted = true
  ticket.requestSequence = requestSequence
  ticket.requestStartedAt = Date.now()
  ticket.settleDeadline = settleDeadline
  bumpTicket(ticket)
}
