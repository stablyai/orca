// Restart offers are durable per-session records. Listing reserves nothing and removes only offers
// the chat has provably moved past; an explicit action reserves records, and only a completed
// action removes them — or files what went wrong.

import { randomUUID } from 'node:crypto'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  continueStructuredAgentSessionAfterRestart,
  noteRestartReattachFailed,
  restartContinuationDeps,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

type LiveSession = { journal: AgentSessionJournal; child: { fence: number } | null }

export type StructuredAgentSessionRestartResumeSurfaces = {
  revealSession: (sessionId: string) => Promise<{ readable: boolean }>
  hold: (sessionId: string, holderId: string) => Promise<void>
  release: (sessionId: string, holderId: string) => void
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  onNoteFailed: (sessionId: string, error: unknown) => void
  now: () => number
}

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
  resume: (
    sessionIds: readonly string[] | undefined,
    owner: string
  ) => Promise<StructuredAgentSessionResumeOutcome[]>
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

  const derive = createStructuredAgentSessionRestartCandidateReader({
    sessions,
    getRecord: deps.store.getRecord,
    adapter: deps.adapter
  })
  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getRecord,
    backgroundTasks: (sessionId) => deps.adapter.backgroundTaskState?.(sessionId)?.tasks,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    teardownId: randomUUID(),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    sessions,
    reveal: async (sessionId) => {
      await surfaces.revealSession(sessionId).catch(() => null)
    },
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    retryable: (marker) => derive([marker], 'may-be-held').candidates.length === 1,
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
      sessions.has(sessionId)
        ? structuredAgentSessionConversationFence(deps.store, sessionId)
        : null,
    stillResumable: (marker, options) =>
      derive([marker], 'may-be-held', options).candidates.length === 1
  }

  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    afterAcquire?: (marker: AgentSessionResumeMarker) => Promise<void>,
    settlement: Omit<Parameters<typeof failures.settle>[2], 'candidates' | 'attempts'> = {
      failureAfterResume: () => null,
      failureReason: () => 'agent_session_resume_refused'
    }
  ): Promise<StructuredAgentSessionResumeOutcome[]> => {
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
      return []
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
    const attempts = failures.attempts(markersBySession)

    let outcomes: StructuredAgentSessionResumeOutcome[]
    try {
      outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          consumeMarker: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            return marker !== undefined && derive([marker], 'may-be-held').candidates.length === 1
          },
          resume: async (sessionId) => {
            const holder = `restart-resume:${sessionId}`
            try {
              await surfaces.hold(sessionId, holder).catch(async (error: unknown) => {
                // The reattach failure is filed like any other, so the chat must say so too.
                await noteRestartReattachFailed(continuationHost, sessionId)
                throw error
              })
              const marker = markersBySession.get(sessionId)
              if (marker) {
                await afterAcquire?.(marker)
              }
            } finally {
              attempts.observe(sessionId)
              surfaces.release(sessionId, holder)
            }
          }
        },
        candidates,
        owner
      )
    } catch (error) {
      if (deps.recoveryCapsule) {
        await enqueueRecoveryOperation(() =>
          deps.recoveryCapsule!.rollbackResume(operationId, surfaces.now())
        ).catch(() => {
          console.warn('[structured-agent-session] restart offer rollback failed')
        })
      }
      throw error
    }
    await failures.settle(operationId, outcomes, { candidates, attempts, ...settlement })
    return outcomes
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
    const continuationFor = (sessionId: string) =>
      continued.find((outcome) => outcome.sessionId === sessionId)
    const resumed = await run(
      sessionIds,
      owner,
      async (marker) => {
        continued.push(
          await continueStructuredAgentSessionAfterRestart(
            restartContinuationDeps(continuationHost, marker),
            marker.sessionId,
            marker
          )
        )
      },
      {
        failureAfterResume: (sessionId) => {
          const outcome = continuationFor(sessionId)
          // Reattached but never asked to continue: nothing confirms the agent carried on.
          return outcome ? continuationFailureOutcome(outcome.outcome) : 'unconfirmed'
        },
        failureReason: (sessionId) => {
          const outcome = continuationFor(sessionId)
          return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
        }
      }
    )
    for (const outcome of resumed) {
      if (outcome.outcome !== 'resumed') {
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
    resume: (sessionIds, owner) => run(sessionIds, owner),
    continueAfterRestart
  }
}
