// Restart offers are durable per-session records. Listing reserves nothing and removes only offers
// the chat has provably moved past; an explicit action reserves records, and only a completed
// action removes them — or files what went wrong. Starting the chat's agent again withdraws them.

import { randomUUID } from 'node:crypto'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { createStructuredAgentSessionRestartCandidateReader } from './structured-agent-session-restart-candidates'
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
import {
  STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER,
  type StructuredAgentSessionRestartResumeSurfaces
} from './structured-agent-session-restart-resume-wiring'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

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
  /** Named sessions forget their offer or failure; unnamed, every durable record goes. */
  dismiss: (sessionIds?: readonly string[]) => Promise<number>
  /** The chat's agent proved a start: its offer ends unless the start is a resume's own. */
  onAgentStarted: (sessionId: string) => void
}

export function createStructuredAgentSessionRestartResume(
  deps: {
    store: AgentSessionRecordStore
    adapter: StructuredAgentSessionAdapter
    recoveryCapsule?: AgentSessionRecoveryCapsule
  },
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getRecord,
    backgroundTasks: (sessionId) => deps.adapter.backgroundTaskState?.(sessionId)?.tasks,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    teardownId: randomUUID(),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
    sessions,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    isContinuation: (clientMessageId) =>
      deps.store.getOperationRow(
        STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER,
        clientMessageId
      ) !== null,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const derive = createStructuredAgentSessionRestartCandidateReader({
    sessions,
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    movedOn: withdrawal.movedOn
  })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    retryable: (marker) => derive([marker], 'may-be-held').candidates.length === 1,
    reveal: (markers) => revealMarkers(markers),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })

  const { readMarkers, readActionMarkers, revealMarkers, retireSuperseded } =
    createStructuredAgentSessionRestartOfferRecords({
      ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
      readFailedMarkers: async () => (await failures.read()).map((failure) => failure.marker),
      hasSession: (sessionId) => sessions.has(sessionId),
      reveal: async (sessionId) => {
        await surfaces.revealSession(sessionId).catch(() => null)
      },
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
    sessions,
    conversationFence: (sessionId) =>
      deps.store.getRecord(sessionId)
        ? structuredAgentSessionConversationFence(deps.store, sessionId)
        : null,
    stillResumable: (marker) => derive([marker], 'may-be-held').candidates.length === 1
  }

  /** One explicit action: reserve the offers, then continue each through `continueOne`, a few at
   *  a time. The runner counts a chat as done once `continueOne` returns. */
  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    continueOne: (marker: AgentSessionResumeMarker, operationId: string) => Promise<void>
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
    const reserved =
      (await enqueueRecoveryOperation(
        () =>
          deps.recoveryCapsule?.beginResume(
            eligible.map((candidate) => candidate.sessionId),
            operationId,
            surfaces.now()
          ) ?? Promise.resolve([])
      )) ?? []
    const markersBySession = new Map(reserved.map((marker) => [marker.sessionId, marker]))
    const candidates = derive(reserved, 'may-be-held').candidates
    const releases = reserved.map((marker) =>
      withdrawal.begin(
        marker.sessionId,
        restartContinuationId(marker.sessionId, marker, operationId)
      )
    )
    try {
      const outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          consumeMarker: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            return marker !== undefined && derive([marker], 'may-be-held').candidates.length === 1
          },
          resume: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            if (marker) {
              await continueOne(marker, operationId)
            }
          }
        },
        candidates,
        owner
      )
      return { operationId, outcomes, candidates, markers: markersBySession, releases }
    } catch (error) {
      for (const release of releases) {
        release()
      }
      if (deps.recoveryCapsule) {
        await enqueueRecoveryOperation(() =>
          deps.recoveryCapsule!.rollbackResume(operationId, surfaces.now())
        ).catch(() => {
          console.warn('[structured-agent-session] restart offer rollback failed')
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
    const action = await run(sessionIds, owner, async (marker, operationId) => {
      const started = await startStructuredAgentSessionContinuation(
        restartContinuationDeps(continuationHost, marker),
        marker.sessionId,
        marker,
        operationId
      )
      if ('done' in started) {
        continued.push(started.done)
        if (started.done.outcome === 'refused') {
          throw new Error(started.done.reason ?? 'agent_session_continuation_refused')
        }
        return
      }
      verdicts.push(started.verdict().then((outcome) => void continued.push(outcome)))
    })
    await Promise.all(verdicts)
    const resumed = action?.outcomes ?? []
    if (action) {
      for (const release of action.releases) {
        release()
      }
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
      console.warn('[structured-agent-session] restart offer refresh failed after action')
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
    dismiss: (sessionIds) => failures.dismiss(sessionIds, witnesses.clear),
    continueAfterRestart,
    onAgentStarted: withdrawal.onAgentStarted
  }
}
