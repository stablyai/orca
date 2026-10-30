import { continuingStructuredAgentSessionInput } from './structured-agent-session-handing-over'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionStartFlightLock } from './structured-agent-session-start-flight'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt-contract'
import { refusedStructuredAgentSessionStart } from './structured-agent-session-start-eligibility'
import {
  refusedStructuredAgentSessionStart as failedStart,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import {
  structuredAgentSessionStartFailure,
  structuredAgentSessionStartFailureFact
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { sameProviderChild } from './structured-agent-session-provider-child'

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
  const outcome = context.tasks.trackAttach(
    Promise.resolve()
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
            const ready = await lock.wait(handle.ended)
            throwIfSignalAborted(acquire.signal)
            if (ready === 'ready') {
              return result
            }
            result = await lock.commit(async () => {
              const session = context.sessions.get(sessionId)
              const ended = session?.lastEndedChild
              const child = handle.result.child
              if (
                !child ||
                !ended ||
                !sameProviderChild(ended, child) ||
                !ended.rootGone ||
                (session?.child && sameProviderChild(session.child, child))
              ) {
                return refusedStructuredAgentSessionStart(
                  'agent_session_ownership_unknown',
                  { reason: 'ownerUnproven' },
                  'The previous agent process could not be verified as stopped.'
                )
              }
              const failure = structuredAgentSessionStartFailureFact({
                exit: handle.result.failure ?? ended.failure
              })
              return {
                ...failedStructuredAgentSessionStart(),
                startKey: ended.generation,
                failure,
                retry:
                  handle.result.retry ??
                  (ended.cause === 'exit' && failure.kind === 'providerStartFailed')
              }
            })
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
      .then(async (result): Promise<StructuredAgentSessionResumeOutcome> => {
        if (result.ok) {
          return result
        }
        return context.serialize(sessionId, async () => {
          const settled = acquire.signal.aborted
            ? {
                ...failedStructuredAgentSessionStart(),
                ...(isStructuredAgentSessionStartupExpired(acquire.signal.reason)
                  ? { expired: true as const }
                  : { aborted: true as const })
              }
            : result
          if (!settled.aborted && (startedFor !== undefined || children.length > 0)) {
            const session = context.sessions.get(sessionId)
            if (session) {
              const record = context.deps.store.getRecord(sessionId)
              const failure = failedStart(record, settled)
              await recordStructuredAgentSessionStartFailure(
                { journal: session.journal, fence: record?.lease.runtimeFence ?? 0 },
                {
                  startKey:
                    children.at(-1)?.generation ?? failure.startKey ?? startedFor ?? attemptId,
                  ...structuredAgentSessionStartFailure(
                    failure.cause,
                    structuredAgentSessionFailureWordsContext(record)
                  )
                },
                startedFor ?? null
              )
            }
          }
          return settled
        })
      })
      .finally(() => {
        acquire.end()
        flights.end(sessionId, attemptId)
        attempts.abandon(sessionId, attemptId)
        context.publishStatus(sessionId)
      })
  )
  register()
  return outcome
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

export function structuredAgentSessionStartStillQueued(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> | undefined,
  startedFor: string | undefined
): boolean {
  return (
    startedFor === undefined ||
    session?.journal
      .submissions()
      .some(
        (entry) =>
          entry.clientMessageId === startedFor &&
          (isQueuedAgentJournalSubmission(entry) ||
            continuingStructuredAgentSessionInput(session.journal, startedFor))
      ) === true
  )
}
