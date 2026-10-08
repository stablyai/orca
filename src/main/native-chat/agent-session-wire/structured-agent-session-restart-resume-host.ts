// Restart offers are durable per-session records. Listing reserves nothing and removes only offers
// the chat has provably moved past; an explicit action reserves records, and only a completed
// action removes them — or files what went wrong. Starting the chat's agent again withdraws them.

import { randomUUID } from 'node:crypto'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import {
  createNewerOrcaChats,
  createStructuredAgentSessionRestartCandidateReaders
} from './structured-agent-session-restart-candidates'
import {
  continuationFailureOutcome,
  createStructuredAgentSessionRestartFailureLedger
} from './structured-agent-session-restart-failure-ledger'
import { createStructuredAgentSessionRestartOperationQueue } from './structured-agent-session-restart-operation-queue'
import { createStructuredAgentSessionRestartOfferRecords } from './structured-agent-session-restart-offer-records'
import {
  restartRowsFor,
  type StructuredAgentSessionRestartAudience,
  type StructuredAgentSessionResumeCandidate
} from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission
} from './structured-agent-session-restart-resume-runner'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import {
  continuationDeps,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { restartContinuationId } from './structured-agent-session-restart-continuation-envelope'
import { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import {
  createStructuredAgentSessionRestartOfferWithdrawal,
  type StructuredAgentSessionRestartOfferSession
} from './structured-agent-session-restart-offer-withdrawal'
import type { StructuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import {
  remainingRestartRows,
  unstartedRestartRefusals
} from './structured-agent-session-restart-action-result'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

type LiveSession = StructuredAgentSessionRestartOfferSession

export type { StructuredAgentSessionRestartResume }

export function createStructuredAgentSessionRestartResume(
  deps: Pick<
    StructuredAgentSessionHostDeps,
    'store' | 'adapter' | 'recoveryCapsule' | 'logger' | 'agents' | 'journalDatabase'
  >,
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getRecord,
    childWork: surfaces.readChildWork,
    startAnswered: (sessionId) => deps.adapter.startAnswered?.(sessionId),
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    teardownId: randomUUID(),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
    sessions,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const newerOrca = createNewerOrcaChats(() => deps.journalDatabase.readOnly)
  const { derive, deriveAtSend } = createStructuredAgentSessionRestartCandidateReaders({
    sessions,
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    agents: deps.agents,
    movedOn: withdrawal.movedOn,
    savedByNewerOrca: newerOrca.has
  })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    getRecord: deps.store.getRecord,
    retryable: (marker) => derive([marker], 'may-be-held').candidates.length === 1,
    savedByNewerOrca: newerOrca.has,
    reveal: (markers) => revealMarkers(markers),
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })

  const { readMarkers, readActionMarkers, revealMarkers, revealEvery, retireSuperseded } =
    createStructuredAgentSessionRestartOfferRecords({
      ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
      readFailedMarkers: async () => (await failures.read()).map((failure) => failure.marker),
      hasSession: (sessionId) => sessions.has(sessionId),
      reveal: async (sessionId) => {
        newerOrca.note(sessionId, await surfaces.revealSession(sessionId).catch(() => null))
      },
      logger: deps.logger,
      now: surfaces.now,
      enqueue: enqueueRecoveryOperation
    })

  const list = async (
    audience?: StructuredAgentSessionRestartAudience
  ): Promise<StructuredAgentSessionResumeCandidate[]> => {
    const markers = await readMarkers()
    await revealMarkers(markers)
    // A live chat remains an offer. The user may have opened it to inspect the context and still
    // explicitly choose whether Orca should ask the agent to continue.
    const { candidates, superseded } = derive(markers, 'may-be-held')
    retireSuperseded(superseded)
    return restartRowsFor(candidates, audience)
  }
  const listFailures = async (audience?: StructuredAgentSessionRestartAudience) =>
    restartRowsFor(await failures.list(), audience)

  const continuationHost: StructuredAgentSessionContinuationHost = {
    ...surfaces,
    logger: deps.logger,
    sessions,
    conversationFence: (sessionId) =>
      deps.store.getRecord(sessionId)
        ? structuredAgentSessionConversationFence(deps.store, sessionId)
        : null,
    stillResumable: (marker) => deriveAtSend([marker], 'may-be-held').candidates.length === 1
  }

  /** One explicit action: reserve the offers, then continue each through `continueOne`, a few at
   *  a time. The runner counts a chat as done once `continueOne` returns. */
  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience: StructuredAgentSessionRestartAudience | undefined,
    continueOne: (marker: AgentSessionResumeMarker, continuationId: string) => Promise<void>
  ) => {
    // An explicit action supersedes teardown witnesses captured by this host. The durable mutation
    // lane below also drains a publication already in flight before completion.
    witnesses.clear(audience)
    const markers = await readActionMarkers(sessionIds)
    await revealMarkers(markers)
    const requested = new Set(sessionIds ?? markers.map((marker) => marker.sessionId))
    const derived = derive(markers, 'may-be-held')
    retireSuperseded(derived.superseded)
    // Only what the caller was shown is reserved; a named offer it cannot see is not.
    const eligible = restartRowsFor(derived.candidates, audience).filter((candidate) =>
      requested.has(candidate.sessionId)
    )
    if (eligible.length === 0) {
      return null
    }
    const operationId = randomUUID()
    const actionAt = surfaces.now()
    // Tagged with its offer, so a rejected one is told apart for as long as the offer lasts.
    const continuationFor = (marker: AgentSessionResumeMarker) =>
      restartContinuationId(marker, operationId, actionAt)
    const reserved =
      (await enqueueRecoveryOperation(
        () =>
          deps.recoveryCapsule?.beginResume(
            eligible.map((candidate) => candidate.sessionId),
            operationId,
            actionAt
          ) ?? Promise.resolve([])
      )) ?? []
    const markersBySession = new Map(reserved.map((marker) => [marker.sessionId, marker]))
    const candidates = derive(reserved, 'may-be-held').candidates
    try {
      const outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          consumeMarker: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            return (
              marker !== undefined && deriveAtSend([marker], 'may-be-held').candidates.length === 1
            )
          },
          resume: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            if (marker) {
              await continueOne(marker, continuationFor(marker))
            }
          }
        },
        candidates,
        owner
      )
      return { operationId, outcomes, candidates, markers: markersBySession }
    } catch (error) {
      if (deps.recoveryCapsule) {
        await enqueueRecoveryOperation(() =>
          deps.recoveryCapsule!.rollbackResume(operationId, surfaces.now())
        ).catch(() => {
          deps.logger.warn('rolling back a restart offer reservation failed', {
            scope: 'restart-offer-rollback',
            operationId
          })
        })
      }
      throw error
    }
  }

  const continueAfterRestart: StructuredAgentSessionRestartResume['continueAfterRestart'] = async (
    sessionIds,
    owner,
    audience
  ) => {
    const continued: StructuredAgentSessionContinuationOutcome[] = []
    const verdicts: Promise<void>[] = []
    // A chat holds its slot until its agent took the continuation or its start failed, so a batch
    // never starts more agents at once than the runner allows; the provider's answer comes after.
    const action = await run(sessionIds, owner, audience, async (marker, continuationId) => {
      const started = await startStructuredAgentSessionContinuation(
        continuationDeps(continuationHost, () => continuationHost.stillResumable(marker)),
        marker.sessionId,
        marker,
        continuationId
      )
      if ('done' in started) {
        continued.push(started.done)
        const { outcome, reason, refusal } = started.done
        if (outcome === 'refused') {
          // Thrown as a refusal so the filed failure keeps its details beside the code.
          throw refusal
            ? new AgentSessionRefusalError(agentSessionRefusalFromReference(refusal, refusal.code))
            : new Error(reason ?? 'agent_session_continuation_refused')
        }
        return
      }
      verdicts.push(started.verdict().then((outcome) => void continued.push(outcome)))
    })
    await Promise.all(verdicts)
    const resumed = action?.outcomes ?? []
    if (action) {
      await failures.settle(action.operationId, resumed, {
        candidates: action.candidates,
        markers: action.markers,
        failureAfterResume: (sessionId) => {
          const outcome = continued.find((entry) => entry.sessionId === sessionId)
          return outcome ? continuationFailureOutcome(outcome.outcome) : null
        },
        failureReason: (sessionId) => {
          const outcome = continued.find((entry) => entry.sessionId === sessionId)
          return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
        }
      })
    }
    continued.push(...unstartedRestartRefusals(resumed, continued))
    return {
      resumed,
      continued,
      ...(await remainingRestartRows(
        () => list(audience),
        () => listFailures(audience),
        deps.logger
      ))
    }
  }

  return {
    beginTeardown: witnesses.begin,
    captureBeforeStop: witnesses.beforeStop,
    confirmStopped: witnesses.stopped,
    recordMarkers: witnesses.record,
    list,
    listFailures,
    // Do not let a teardown witness already captured in this host republish after explicit
    // dismissal. A later capture is a new interruption and may create a fresh offer normally.
    // "Dismiss all" keeps what this host does not list, so it reveals every record's chat first.
    dismiss: (sessionIds, audience) =>
      failures.dismiss(
        sessionIds,
        async (clearAudience) => {
          witnesses.clear(clearAudience)
          await revealEvery()
        },
        audience
      ),
    continueAfterRestart,
    onAgentStarted: withdrawal.onAgentStarted,
    continueInterrupted: createInterruptedContinuation(continuationHost, readMarkers)
  }
}
