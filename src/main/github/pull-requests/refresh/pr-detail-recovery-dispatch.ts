import { PR_DETAIL_RECOVERY_SETTLE_BUDGET_MS } from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { githubPRTransportFailureOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-for-branch-outcome'
import { getPRForBranchOutcome } from '../../client/lookup/pr-for-branch-outcome'
import { hostedReviewOptionArgs } from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import {
  prRefreshRequestDigest,
  type PRRefreshRequestRegistry
} from './pr-refresh-request-registry'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRDetailRecoveryTickets } from './pr-detail-recovery-tickets'
import { admitTicket, type PRDetailRecoveryTicket } from './pr-detail-recovery-ticket-model'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'

export type PRDetailRecoveryDispatchDeps = {
  queue: PRRefreshQueue
  pacing: PRRefreshPacing
  retry: PRRefreshRetryState
  events: PRRefreshEventPublisher
  requests: PRRefreshRequestRegistry
  tickets: PRDetailRecoveryTickets
  registrationCheck: () => ((candidate: PRRefreshQueueEntry['candidate']) => boolean) | null
  schedule: () => void
  followUp: (entry: PRRefreshQueueEntry, outcome: PRRefreshOutcome) => void
}

/** Equivalent ordinary queued work rides this read; its subscribers keep their own follow-up. */
function absorbEquivalentQueued(
  deps: PRDetailRecoveryDispatchDeps,
  ticket: PRDetailRecoveryTicket
): PRRefreshQueueEntry | null {
  const queued = deps.queue.get(ticket.slotKey)
  if (
    !queued ||
    queued.watch ||
    queued.recovery ||
    prRefreshRequestDigest(queued.candidate) !== prRefreshRequestDigest(ticket.candidate)
  ) {
    return null
  }
  deps.queue.delete(ticket.slotKey)
  return queued
}

async function readOutcome(ticket: PRDetailRecoveryTicket): Promise<PRRefreshOutcome> {
  const candidate = ticket.candidate
  try {
    return await getPRForBranchOutcome(
      candidate.repoPath,
      candidate.branch,
      candidate.linkedPRNumber ?? null,
      candidate.connectionId ?? null,
      candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
      ...hostedReviewOptionArgs(candidate, 'active')
    )
  } catch {
    // A throw is a classified transport failure; it never caches null.
    return githubPRTransportFailureOutcome()
  }
}

async function gateUntil(
  deps: PRDetailRecoveryDispatchDeps,
  ticket: PRDetailRecoveryTicket
): Promise<number> {
  const pausedUntil = await prRefreshRateLimitPausedUntil(ticket.candidate, true)
  return Math.max(
    pausedUntil ?? 0,
    deps.queue.backgroundUntil(ticket.slotKey),
    deps.retry.manualGateUntil(ticket.slotKey)
  )
}

/** Drainer turn for a ticket entry: prepare it, or dispatch the committed read under its grant. */
export async function runPRDetailRecoveryEntry(
  deps: PRDetailRecoveryDispatchDeps,
  entry: PRRefreshQueueEntry
): Promise<void> {
  const recovery = entry.recovery
  const ticket = recovery ? deps.tickets.get(recovery.ticketId) : undefined
  if (!recovery || !ticket || ticket.terminal) {
    deps.queue.delete(entry.key)
    return
  }
  const candidate = ticket.candidate
  if (!(deps.registrationCheck()?.(candidate) ?? true)) {
    deps.tickets.close(ticket, { kind: 'not-admitted', reason: 'unregistered' })
    return
  }
  // A recovery never starts a stopped distro; the panel reports it instead of waiting.
  if (
    wslDistroForPath(candidate.repoPath, candidate.localGitOptions?.wslDistro) &&
    (await blockedWslDistroForPath(candidate.repoPath, candidate.localGitOptions?.wslDistro))
  ) {
    deps.tickets.close(ticket, { kind: 'not-admitted', reason: 'host-off' })
    return
  }
  const until = await gateUntil(deps, ticket)
  if (ticket.terminal || deps.queue.get(entry.key) !== entry) {
    return
  }
  if (until > Date.now()) {
    deps.tickets.pause(ticket, until)
    return
  }
  if (!recovery.committed) {
    deps.tickets.prepare(ticket)
    return
  }
  deps.queue.delete(entry.key)
  const absorbed = absorbEquivalentQueued(deps, ticket)
  const absorbedAliases = absorbed ? Array.from(absorbed.aliases.values()) : []
  const requestSequence = deps.events.nextSequence()
  const requestStartedAt = Date.now()
  deps.queue.noteRequestStarted(ticket.slotKey, requestSequence)
  deps.pacing.noteActiveStart(entry)
  admitTicket(ticket, requestSequence, requestStartedAt + PR_DETAIL_RECOVERY_SETTLE_BUDGET_MS)
  deps.schedule()
  if (absorbedAliases.length > 0) {
    deps.events.broadcast(
      { aliases: absorbedAliases, reason: absorbed!.reason, status: 'in-flight', requestStartedAt },
      requestSequence
    )
  }
  const requestId = `t:${ticket.ticketId}`
  deps.requests.start({
    requestId,
    slotKey: ticket.slotKey,
    registrationOrder: ticket.acceptOrder,
    identityDigest: prRefreshRequestDigest(candidate)
  })
  let outcome: PRRefreshOutcome
  try {
    outcome = await readOutcome(ticket)
  } finally {
    deps.requests.settle(requestId)
  }
  // A newer read owns the slot now: its outcome, not this late one, sets gates and notifies observers.
  const ownsSlot = deps.queue.ownsRequest(ticket.slotKey, requestSequence)
  if (ownsSlot) {
    deps.events.observe(candidate, outcome, [ticket.alias, ...absorbedAliases])
    deps.retry.noteManualGate(ticket.slotKey, outcome)
  }
  if (absorbed && ownsSlot) {
    deps.events.broadcast(
      { aliases: absorbedAliases, reason: absorbed.reason, outcome, requestStartedAt },
      requestSequence
    )
    deps.followUp(absorbed, outcome)
  }
  // Timeout, supersession or cancel already closed publication; the late outcome is not delivered.
  deps.tickets.close(ticket, { kind: 'settled', outcome })
}
