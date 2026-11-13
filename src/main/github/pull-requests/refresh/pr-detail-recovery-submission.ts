import { randomUUID } from 'node:crypto'
import {
  PR_DETAIL_RECOVERY_LEASE_MS,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryStartArgs
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { aliasFromCandidate, refreshKey } from './pr-refresh-candidate-policy'
import type { PRRefreshQueue } from './pr-refresh-queue'
import {
  prRefreshRequestDigest,
  queuedRequestId,
  type PRRefreshRequestRegistry
} from './pr-refresh-request-registry'
import type {
  PRDetailRecoveryCaller,
  PRDetailRecoveryTicket
} from './pr-detail-recovery-ticket-model'

type Predecessor = PRDetailRecoverySnapshot['predecessors'][number]

/** Work already registered on the slot at submission; the set never grows to later requests. */
export function certifyPRDetailRecoveryPredecessors(
  queue: PRRefreshQueue,
  requests: PRRefreshRequestRegistry,
  slotKey: string
): Predecessor[] {
  const predecessors: Predecessor[] = requests
    .readsFor(slotKey)
    .map(({ requestId, registrationOrder, identityDigest }) => ({
      requestId,
      registrationOrder,
      identityDigest
    }))
  const queued = queue.get(slotKey)
  // Periodic follow-ups and watch reads are scheduled future work, not outstanding requests.
  if (queued && queued.followUp !== true && !queued.watch) {
    predecessors.push({
      requestId: queuedRequestId(queued),
      registrationOrder: queued.queuedAt,
      identityDigest: prRefreshRequestDigest(queued.candidate)
    })
  }
  return predecessors
}

/** A predecessor settles when its read finishes or its queued registration is gone or retargeted. */
export function prDetailRecoveryPredecessorOutstanding(
  queue: PRRefreshQueue,
  requests: PRRefreshRequestRegistry,
  ticket: PRDetailRecoveryTicket,
  predecessor: Predecessor
): boolean {
  if (requests.has(predecessor.requestId)) {
    return true
  }
  const queued = queue.get(ticket.slotKey)
  return (
    queued !== undefined &&
    queuedRequestId(queued) === predecessor.requestId &&
    prRefreshRequestDigest(queued.candidate) === predecessor.identityDigest
  )
}

export function createPRDetailRecoveryTicket(
  queue: PRRefreshQueue,
  requests: PRRefreshRequestRegistry,
  input: {
    caller: PRDetailRecoveryCaller
    args: PRDetailRecoveryStartArgs
    candidate: GitHubPRRefreshCandidate
    epochKey: string
    digest: string
    acceptSequence: number
  }
): PRDetailRecoveryTicket {
  const slotKey = refreshKey(input.candidate)
  const predecessors = certifyPRDetailRecoveryPredecessors(queue, requests, slotKey)
  return {
    ticketId: randomUUID(),
    caller: input.caller,
    epochKey: input.epochKey,
    counter: input.args.clientEpoch.counter,
    identity: input.args.identity,
    digest: input.digest,
    candidate: input.candidate,
    alias: aliasFromCandidate(input.candidate),
    slotKey,
    acceptSequence: input.acceptSequence,
    acceptOrder: queue.nextOrder(),
    predecessors,
    revision: 1,
    phase: predecessors.length > 0 ? 'waiting-existing' : 'queued',
    admitted: false,
    leaseUntil: Date.now() + PR_DETAIL_RECOVERY_LEASE_MS,
    waiters: new Set()
  }
}
