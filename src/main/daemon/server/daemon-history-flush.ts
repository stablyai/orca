import type { TerminalHost } from '../terminal-host/terminal-host'
import { beginTerminalHostSleepTermination } from '../terminal-host/terminal-host-sleep-termination'
import type {
  FlushHistoryRequest,
  FlushHistoryResult,
  FlushHistoryUnavailableReason
} from '../protocol/daemon-history-protocol'
import type { TerminalJournalOperationFailure } from '../history/journal/terminal-journal-operation'

// A caller that sends no budget still gets a finite one, as deep reads do.
const FLUSH_HISTORY_BUDGET_MS = 30_000

type Unavailable = Extract<FlushHistoryResult, { status: 'unavailable' }>

/**
 * commit: make the admitted cut C durable, with its ordered folder note, and leave the terminal
 * running. sleep: after the committed source covering C is rebuilt from files, end the exact
 * process through its existing teardown and publish the physically final cut F.
 */
export async function flushDaemonHistory(
  host: TerminalHost,
  payload: FlushHistoryRequest['payload'],
  disconnected: AbortSignal
): Promise<FlushHistoryResult> {
  const budget = payload.remainingBudgetMs
  const signal = AbortSignal.any([
    disconnected,
    AbortSignal.timeout(
      typeof budget === 'number' && Number.isFinite(budget)
        ? Math.max(1, Math.min(FLUSH_HISTORY_BUDGET_MS, budget))
        : FLUSH_HISTORY_BUDGET_MS
    )
  ])
  const { sessionId, expectedIncarnationId: expected, intent } = payload
  const journals = host.historyJournals
  const journal =
    typeof expected === 'string' && (intent === 'commit' || intent === 'sleep')
      ? journals?.live(sessionId, expected)
      : undefined
  const session = journal?.session
  if (!journals || !journal || !session) {
    return unavailable('preflight', 'absent')
  }
  const incarnationId = journal.incarnation
  try {
    // The barriers a deep read uses: settled ownership and released startup bytes join C.
    await untilAborted(session.settleShellOwnershipConfirmation(), signal)
  } catch {
    return unavailable('preflight', abortReason(signal), incarnationId)
  }
  session.snapshotBarrier()
  if (journals.live(sessionId, expected) !== journal) {
    return unavailable('preflight', 'absent', incarnationId)
  }
  const observation = payload.cwdObservation
  const operation = journal.admitOperation(
    intent,
    observation === undefined ? undefined : String(observation?.cwd ?? '')
  )
  if (typeof operation === 'string') {
    return unavailable('preflight', operation, incarnationId)
  }
  if (intent === 'commit') {
    let position
    try {
      position = await untilAborted(operation.publication.promise, signal)
    } catch {
      // The admitted publication still completes; only this waiter leaves.
      return unavailable('preflight', abortReason(signal), incarnationId)
    }
    return position
      ? {
          status: 'committed',
          incarnationId,
          appliedRevision: operation.cut.appliedRevision,
          outputSequence: operation.cut.outputSequence,
          ...position,
          cwdNote: operation.cwdNote
        }
      : failed(operation.failure, incarnationId)
  }
  let verified: boolean
  try {
    verified = await untilAborted(journal.preflightSleep(operation), signal)
  } catch {
    journal.cancelSleep(operation)
    return unavailable('preflight', abortReason(signal), incarnationId)
  }
  if (!verified) {
    return failed(operation.failure, incarnationId)
  }
  // One synchronous turn: nothing may change between this proof and the reservation.
  if (signal.aborted) {
    journal.cancelSleep(operation)
    return unavailable('preflight', abortReason(signal), incarnationId)
  }
  if (
    journals.live(sessionId, expected) !== journal ||
    journal.gapped ||
    !journal.holdsOperation(operation)
  ) {
    journal.refuseSleep(operation, journal.gapped ? 'gap' : 'absent')
    return unavailable('preflight', journal.gapped ? 'gap' : 'absent', incarnationId)
  }
  const termination = beginTerminalHostSleepTermination(
    {
      id: sessionId,
      expectedIncarnationId: expected,
      immediate: payload.immediate === true,
      onAccepted: () => journal.authorizeSleep(operation)
    },
    { session, kill: (id, options) => host.kill(id, options) }
  )
  if (!termination.accepted) {
    journal.refuseSleep(operation, termination.reason)
    return unavailable('preflight', termination.reason, incarnationId)
  }
  // Owned by the operation, not this waiter: a later refused signal frees the slot.
  void termination.completion.then(() => {
    if (termination.refused()) {
      journal.rollbackSleep(operation)
    }
  })
  try {
    const outcome = await untilAborted(operation.outcome.promise, signal)
    return 'reason' in outcome
      ? unavailable(outcome.phase, outcome.reason, incarnationId)
      : { status: 'finalized', incarnationId, ...outcome, cwdNote: operation.cwdNote }
  } catch {
    // Teardown and final publication continue; this waiter cannot know their outcome.
    return unavailable('authorized', abortReason(signal), incarnationId)
  }
}

function unavailable(
  phase: Unavailable['phase'],
  reason: FlushHistoryUnavailableReason,
  incarnationId?: string
): Unavailable {
  return { status: 'unavailable', phase, reason, ...(incarnationId ? { incarnationId } : {}) }
}

function failed(
  failure: TerminalJournalOperationFailure | null,
  incarnationId: string
): Unavailable {
  return unavailable(failure?.phase ?? 'preflight', failure?.reason ?? 'gap', incarnationId)
}

function abortReason(signal: AbortSignal): 'canceled' | 'deadline' {
  // AbortSignal.timeout aborts with a DOMException, an Error named TimeoutError.
  const reason: unknown = signal.reason
  return reason instanceof Error && reason.name === 'TimeoutError' ? 'deadline' : 'canceled'
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
