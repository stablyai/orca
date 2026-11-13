import type {
  PRDetailRecoveryCommitArgs,
  PRDetailRecoveryNotAdmittedReason,
  PRDetailRecoverySnapshot,
  PRDetailRecoveryStartArgs
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { aliasFromCandidate, refreshKey } from './pr-refresh-candidate-policy'
import { drainer, events, pacing, queue, retry } from './pr-refresh-coordinator-state'
import { prRefreshRequestDigest } from './pr-refresh-request-registry'
import { runPRDetailRecoveryEntry } from './pr-detail-recovery-dispatch'
import { PRDetailRecoveryTickets } from './pr-detail-recovery-tickets'
import type { PRDetailRecoveryCaller } from './pr-detail-recovery-ticket-model'

const tickets = new PRDetailRecoveryTickets({
  queue,
  requests: drainer.requests,
  retry,
  scheduleDrain: () => drainer.schedule()
})

let recheckQueued = false
// Deferred so a queue mutation finishes its own bookkeeping before tickets inspect it.
function queueRecheck(): void {
  if (recheckQueued) {
    return
  }
  recheckQueued = true
  queueMicrotask(() => {
    recheckQueued = false
    tickets.recheck()
  })
}

queue.setChangeListener(queueRecheck)
drainer.requests.setListeners({
  onSettled: queueRecheck,
  onRegistered: (registration) => tickets.onRegistration(registration)
})
drainer.setRecoveryHooks({
  run: (entry) =>
    runPRDetailRecoveryEntry(
      {
        queue,
        pacing,
        retry,
        events,
        requests: drainer.requests,
        tickets,
        registrationCheck: () => drainer.registrationCheck,
        schedule: () => drainer.schedule(),
        followUp: (absorbed, outcome) =>
          drainer.scheduleVisibleFollowUp(
            absorbed.key,
            absorbed.candidate,
            outcome,
            absorbed.priority,
            Array.from(absorbed.aliases.values()),
            absorbed.windowId
          )
      },
      entry
    ),
  tick: () => tickets.tick()
})

let directOrder = 0

/** Register host work on a slot; with a kind it is an outstanding read and the return settles it. */
export function registerPRRefreshRequest(
  candidate: GitHubPRRefreshCandidate,
  kind: 'd' | 'h' | null,
  independent: boolean
): () => void {
  const slotKey = refreshKey(candidate)
  const registrationOrder = queue.nextOrder()
  if (independent) {
    drainer.requests.register({
      slotKey,
      registrationOrder,
      independent,
      aliases: [aliasFromCandidate(candidate)]
    })
  }
  if (kind === null) {
    return () => {}
  }
  directOrder += 1
  const requestId = `${kind}:${directOrder}`
  drainer.requests.start({
    requestId,
    slotKey,
    registrationOrder,
    identityDigest: prRefreshRequestDigest(candidate)
  })
  return () => drainer.requests.settle(requestId)
}

export function startPRDetailRecovery(
  caller: PRDetailRecoveryCaller,
  args: PRDetailRecoveryStartArgs,
  resolved: GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason
): PRDetailRecoverySnapshot {
  return tickets.start(caller, args, resolved)
}

export function waitPRDetailRecovery(
  callerKey: string,
  ticketId: string,
  afterRevision: number,
  signal?: AbortSignal
): Promise<PRDetailRecoverySnapshot | null> {
  return tickets.wait(callerKey, ticketId, afterRevision, signal)
}

export function commitPRDetailRecovery(
  callerKey: string,
  args: PRDetailRecoveryCommitArgs
): PRDetailRecoverySnapshot | null {
  return tickets.commit(callerKey, args)
}

export function cancelPRDetailRecovery(
  callerKey: string,
  ticketId: string
): PRDetailRecoverySnapshot | null {
  return tickets.cancel(callerKey, ticketId)
}

export function cancelPRDetailRecoveryCaller(callerKey: string): void {
  tickets.cancelCaller(callerKey)
}
