import { structuredAgentSessionHandingOver } from '../delivery/structured-agent-session-handing-over'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { refuseUnclassified } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionWriteNoticeEnglish } from '../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from '../acquisition/structured-agent-session-attach-lock'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionStartFlightLock } from './structured-agent-session-start-flight'
import {
  isStructuredAgentSessionStartupContractBreach,
  isStructuredAgentSessionStartupExpired
} from './structured-agent-session-startup-attempt-contract'
import type { AgentSessionStartFailure } from './structured-agent-session-start-failure'
import { refusedStructuredAgentSessionStart } from './structured-agent-session-start-eligibility'
import {
  refusedStructuredAgentSessionStart as failedStart,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'

export function registerStructuredAgentSessionStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined,
  run: (
    lock: StructuredAgentSessionAttachLock,
    attemptId: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
): Promise<StructuredAgentSessionResumeOutcome> {
  const { startFlights: flights, startupAttempts: attempts, acquireAborts } = context.runtimeState
  const acquire = acquireAborts.begin(sessionId)
  let attemptId = randomUUID()
  let handle = attempts.begin(sessionId, attemptId)
  const registeredAt = handle.registeredAt
  const children: NonNullable<ReturnType<typeof flights.get>>['children'] = []
  const register = () =>
    flights.register(sessionId, {
      attemptId,
      outcome,
      abort: acquire.abort,
      signal: acquire.signal,
      children
    })
  const attempting = Promise.resolve()
    .then(async (): Promise<StructuredAgentSessionResumeOutcome> => {
      let result: StructuredAgentSessionResumeOutcome = failedStructuredAgentSessionStart()
      for (let number = 0; number < 5; number++) {
        throwIfSignalAborted(acquire.signal)
        if (attempts.pastCeiling(registeredAt)) {
          result = { ...failedStructuredAgentSessionStart(), expired: true }
          break
        }
        const lock = structuredAgentSessionStartFlightLock({
          sessionId,
          attemptId,
          signal: acquire.signal,
          flights,
          serialize: context.serialize
        })
        const stillQueued = await lock.commit(async () =>
          structuredAgentSessionStartStillQueued(context.sessions.get(sessionId), startedFor)
        )
        if (!stillQueued) {
          return { ...failedStructuredAgentSessionStart(), aborted: true }
        }
        result = await run(lock, attemptId)
        if (result.ok) {
          // The child's open owns its outcome; readiness ends once that open gave it.
          const ready = await lock.wait(handle.ended)
          throwIfSignalAborted(acquire.signal)
          if (ready === 'ready') {
            return result
          }
          const owned = handle.result
          result = await lock.commit(async () =>
            structuredAgentSessionOpenFailure(context.sessions.get(sessionId), owned)
          )
        }
        if (result.ok || result.aborted || result.expired || !result.retry || number === 4) {
          break
        }
        attempts.abandon(sessionId, attemptId)
        await waitForPromiseWithSignal(delay(100 * 2 ** number), acquire.signal)
        throwIfSignalAborted(acquire.signal)
        attemptId = randomUUID()
        handle = attempts.begin(sessionId, attemptId, registeredAt)
        register()
      }
      return result
    })
    .catch((error: unknown): StructuredAgentSessionResumeOutcome => {
      if (!acquire.signal.aborted) {
        context.deps.logger.warn('starting the agent failed', {
          scope: 'agent-start',
          sessionId,
          error
        })
        return {
          ...failedStructuredAgentSessionStart(),
          failure: agentSessionFailureFact('hostFault')
        }
      }
      return failedStructuredAgentSessionStart()
    })
  let recorded: Promise<void> = Promise.resolve()
  // Stop, close, quit, the deadline and the contract guard decide the start at once, even while
  // its attempt or the session's serialized work is still held; late attempt work fails the
  // flight's commit check. The failure row is queued before callers wake, so their work follows
  // it, but they never wait for it to be written.
  const outcome = Promise.race([
    attempting,
    stoppedStructuredAgentSessionStartSignal(acquire.signal)
  ])
    .then((result): StructuredAgentSessionResumeOutcome => {
      const settled =
        result.ok || !acquire.signal.aborted
          ? result
          : stoppedStructuredAgentSessionStart(acquire.signal.reason)
      if (!settled.ok && !settled.aborted && (startedFor !== undefined || children.length > 0)) {
        const key = { generation: children.at(-1)?.generation, startedFor, attemptId }
        recorded = context
          .serialize(sessionId, () =>
            recordStructuredAgentSessionFlightFailure(context, sessionId, settled, key)
          )
          .catch((error: unknown) =>
            context.deps.logger.warn('recording a failed start did not finish', {
              scope: 'agent-start',
              sessionId,
              error
            })
          )
      }
      return settled
    })
    .finally(() => {
      acquire.end()
      flights.end(sessionId, attemptId)
      attempts.abandon(sessionId, attemptId)
      context.publishStatus(sessionId)
    })
  context.tasks.trackAttach(outcome.then(() => Promise.all([attempting, recorded])))
  register()
  return outcome
}

function stoppedStructuredAgentSessionStartSignal(
  signal: AbortSignal
): Promise<StructuredAgentSessionResumeOutcome> {
  return new Promise((resolve) => {
    const stopped = (): void => resolve(stoppedStructuredAgentSessionStart(signal.reason))
    if (signal.aborted) {
      stopped()
    } else {
      signal.addEventListener('abort', stopped, { once: true })
    }
  })
}

async function recordStructuredAgentSessionFlightFailure(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  settled: Extract<StructuredAgentSessionResumeOutcome, { ok: false }>,
  key: { generation: string | null | undefined; startedFor: string | undefined; attemptId: string }
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  const record = context.deps.store.getRecord(sessionId)
  const failure = failedStart(record, settled)
  await recordStructuredAgentSessionStartFailure(
    { journal: session.journal, fence: record?.lease.runtimeFence ?? 0 },
    {
      startKey: key.generation ?? failure.startKey ?? key.startedFor ?? key.attemptId,
      ...structuredAgentSessionStartFailure(
        failure.cause,
        structuredAgentSessionFailureWordsContext(record)
      )
    },
    key.startedFor ?? null
  )
}

export function failedStructuredAgentSessionStart(): Extract<
  StructuredAgentSessionResumeOutcome,
  { ok: false }
> {
  return {
    ok: false,
    refusal: refuseUnclassified(
      'agent_session_owner_restart_failed',
      agentSessionWriteNoticeEnglish(['restartFailed'])
    )
  }
}

export async function structuredAgentSessionStartStillQueued(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> | undefined,
  startedFor: string | undefined
): Promise<boolean> {
  if (startedFor === undefined) {
    return true
  }
  if (!session) {
    return false
  }
  const entry = await session.journal.reads.submission(startedFor)
  const input = structuredAgentSessionHandingOver(session.journal).get(startedFor)?.input
  return (
    entry !== undefined &&
    (isQueuedAgentJournalSubmission(entry) ||
      (entry.dispatchState === 'pending' &&
        input?.unadmitted === true &&
        input.signal?.aborted !== true))
  )
}

/** A safe verdict replays only once this child's exit is proven; no verdict replays nothing. */
function structuredAgentSessionOpenFailure(
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> | undefined,
  {
    child,
    failure
  }: {
    child: StructuredAgentSessionProviderChildIdentity | null
    failure?: AgentSessionStartFailure
  }
): StructuredAgentSessionResumeOutcome {
  const ended = session?.lastEndedChild
  const exitProven =
    !!child &&
    !!ended?.rootGone &&
    sameProviderChild(ended, child) &&
    !(session?.child && sameProviderChild(session.child, child))
  if (!child || !failure || (failure.retry === 'safe' && !exitProven)) {
    return refusedStructuredAgentSessionStart(
      'agent_session_ownership_unknown',
      { reason: 'ownerUnproven' },
      'The previous agent process could not be verified as stopped.'
    )
  }
  return {
    ...failedStructuredAgentSessionStart(),
    startKey: child.generation,
    failure: failure.fact,
    retry: failure.retry === 'safe'
  }
}

/** The deadline keeps its own outcome; a broken adapter contract fails the start; anything else
 *  stopping it is cancellation. */
function stoppedStructuredAgentSessionStart(
  reason: unknown
): Extract<StructuredAgentSessionResumeOutcome, { ok: false }> {
  if (isStructuredAgentSessionStartupExpired(reason)) {
    return { ...failedStructuredAgentSessionStart(), expired: true }
  }
  if (isStructuredAgentSessionStartupContractBreach(reason)) {
    return {
      ...failedStructuredAgentSessionStart(),
      failure: agentSessionFailureFact('providerStartFailed')
    }
  }
  return { ...failedStructuredAgentSessionStart(), aborted: true }
}
