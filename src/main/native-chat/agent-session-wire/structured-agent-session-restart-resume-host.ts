// Restart offers are durable per-session records. Listing reserves nothing and removes only offers
// the chat has provably moved past; an explicit action reserves records, and only a completed
// action removes them — or files what went wrong. Starting the chat's agent again withdraws them.

import { randomUUID } from 'node:crypto'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
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
import type {
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
import {
  restartContinuationDeps,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { restartContinuationId } from './structured-agent-session-restart-continuation-envelope'
import {
  createStructuredAgentSessionRestartOfferWithdrawal,
  type StructuredAgentSessionRestartOfferSession
} from './structured-agent-session-restart-offer-withdrawal'
import type { StructuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type LiveSession = StructuredAgentSessionRestartOfferSession

export type StructuredAgentSessionRestartResume = {
  /** Teardown: begin, then per session a snapshot right before its child stops and a confirmation
   *  once the stop is proven, then one write of the confirmed offers. */
  beginTeardown: (trigger: AgentSessionResumeTrigger) => void
  captureBeforeStop: (sessionId: string) => void
  confirmStopped: (sessionId: string) => void
  recordMarkers: () => Promise<void>
  list: () => Promise<StructuredAgentSessionResumeCandidate[]>
  /** Offers already acted on whose agent did not carry on. Read-only; nothing here is spent. */
  listFailures: () => Promise<StructuredAgentSessionResumeFailure[]>
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string
  ) => Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    sessions?: StructuredAgentSessionResumeCandidate[]
    failed?: StructuredAgentSessionResumeFailure[]
  }>
  /** Named sessions forget their offer or failure; unnamed, every record this host
   *  lists goes (a newer Orca's stay). */
  dismiss: (sessionIds?: readonly string[]) => Promise<number>
  /** The chat's agent proved a start: its offer ends unless the start is a resume's own. */
  onAgentStarted: (sessionId: string) => void
}

export function createStructuredAgentSessionRestartResume(
  deps: {
    store: AgentSessionRecordStore
    adapter: StructuredAgentSessionAdapter
    recoveryCapsule?: AgentSessionRecoveryCapsule
    logger: StructuredAgentSessionLogger
    journalDatabase: Pick<JournalHostDatabase, 'readOnly'>
  },
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getRecord,
    childWork: surfaces.readChildWork,
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
    movedOn: withdrawal.movedOn,
    savedByNewerOrca: newerOrca.has
  })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
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

  const list = async (): Promise<StructuredAgentSessionResumeCandidate[]> => {
    const markers = await readMarkers()
    await revealMarkers(markers)
    // A live chat remains an offer. The user may have opened it to inspect the context and still
    // explicitly choose whether Orca should ask the agent to continue.
    const { candidates, superseded } = derive(markers, 'may-be-held')
    retireSuperseded(superseded)
    return candidates
  }

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
    continueOne: (marker: AgentSessionResumeMarker, continuationId: string) => Promise<void>
  ) => {
    // An explicit action supersedes teardown witnesses captured by this host. The durable mutation
    // lane below also drains a publication already in flight before completion.
    witnesses.clear()
    const markers = await readActionMarkers(sessionIds)
    await revealMarkers(markers)
    const requested = new Set(sessionIds ?? markers.map((marker) => marker.sessionId))
    const derived = derive(markers, 'may-be-held')
    retireSuperseded(derived.superseded)
    const eligible = derived.candidates.filter((candidate) => requested.has(candidate.sessionId))
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

  const continueAfterRestart = async (
    sessionIds: readonly string[] | undefined,
    owner: string
  ): Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    sessions?: StructuredAgentSessionResumeCandidate[]
    failed?: StructuredAgentSessionResumeFailure[]
  }> => {
    const continued: StructuredAgentSessionContinuationOutcome[] = []
    const verdicts: Promise<void>[] = []
    // A chat holds its slot until its agent took the continuation or its start failed, so a batch
    // never starts more agents at once than the runner allows; the provider's answer comes after.
    const action = await run(sessionIds, owner, async (marker, continuationId) => {
      const started = await startStructuredAgentSessionContinuation(
        restartContinuationDeps(continuationHost, marker),
        marker.sessionId,
        marker,
        continuationId
      )
      if ('done' in started) {
        continued.push(started.done)
        const { reason, refusal } = started.done
        if (continuationFailureOutcome(started.done) === 'refused') {
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
          return outcome ? continuationFailureOutcome(outcome) : null
        },
        failureReason: (sessionId) => {
          const outcome = continued.find((entry) => entry.sessionId === sessionId)
          return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
        }
      })
    }
    for (const outcome of resumed) {
      if (
        outcome.outcome !== 'resumed' &&
        !continued.some((entry) => entry.sessionId === outcome.sessionId)
      ) {
        continued.push({
          sessionId: outcome.sessionId,
          outcome: 'refused',
          reason: outcome.reason ?? 'agent_session_resume_refused'
        })
      }
    }
    let remainingCandidates: StructuredAgentSessionResumeCandidate[] | undefined
    let remainingFailures: StructuredAgentSessionResumeFailure[] | undefined
    try {
      remainingCandidates = await list()
      remainingFailures = await failures.list()
    } catch {
      deps.logger.warn('refreshing restart offers after an action failed', {
        scope: 'restart-offer-refresh'
      })
    }
    return {
      resumed,
      continued,
      ...(remainingCandidates === undefined ? {} : { sessions: remainingCandidates }),
      ...(remainingFailures === undefined ? {} : { failed: remainingFailures })
    }
  }

  return {
    beginTeardown: witnesses.begin,
    captureBeforeStop: witnesses.beforeStop,
    confirmStopped: witnesses.stopped,
    recordMarkers: witnesses.record,
    list,
    listFailures: failures.list,
    // Do not let a teardown witness already captured in this host republish after explicit
    // dismissal. A later capture is a new interruption and may create a fresh offer normally.
    // "Dismiss all" keeps what this host does not list, so it reveals every record's chat first.
    dismiss: (sessionIds) =>
      failures.dismiss(sessionIds, async () => {
        witnesses.clear()
        await revealEvery()
      }),
    continueAfterRestart,
    onAgentStarted: withdrawal.onAgentStarted
  }
}
