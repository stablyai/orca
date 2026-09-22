// Restart offers are durable per-session records. Listing is read-only; only an explicit action
// reserves records, and only a completed action removes them.

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
import { createStructuredAgentSessionRestartOperationQueue } from './structured-agent-session-restart-operation-queue'
import type { StructuredAgentSessionResumeCandidate } from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
import {
  continueStructuredAgentSessionAfterRestart,
  RestartContinuationSupersededError,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { structuredAgentSessionsWorkingAtTeardown } from './structured-agent-session-working-at-teardown'

type LiveSession = { journal: AgentSessionJournal; hasProviderChild: boolean; fence: number }

export type StructuredAgentSessionRestartResumeSurfaces = {
  publish: (sessionId: string, journal: AgentSessionJournal) => void
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
  captureMarkers: (trigger: AgentSessionResumeTrigger) => void
  confirmStoppedMarker: (sessionId: string) => void
  recordMarkers: () => Promise<void>
  list: () => Promise<StructuredAgentSessionResumeCandidate[]>
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
  }>
  dismiss: () => Promise<number>
}

export function createStructuredAgentSessionRestartResume(
  deps: {
    store: AgentSessionRecordStore
    adapter: StructuredAgentSessionAdapter
    recoveryCapsule?: Pick<
      AgentSessionRecoveryCapsule,
      'list' | 'record' | 'beginResume' | 'completeResume' | 'rollbackResume' | 'clearAll'
    >
  },
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const teardownId = randomUUID()
  let teardownMarkers = new Map<string, AgentSessionResumeMarker>()
  const confirmedMarkers = new Map<string, AgentSessionResumeMarker>()
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const derive = createStructuredAgentSessionRestartCandidateReader({
    sessions,
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    now: surfaces.now
  })

  const readMarkers = async (): Promise<AgentSessionResumeMarker[]> => {
    try {
      return (await deps.recoveryCapsule?.list(surfaces.now())) ?? []
    } catch {
      // Recovery is advisory. A malformed capsule must not make ordinary chat actions unusable;
      // the durable bytes stay untouched so an explicit dismissal can remove them.
      console.warn('[structured-agent-session] reading recovery capsule failed')
      return []
    }
  }

  const revealMarkers = async (markers: readonly AgentSessionResumeMarker[]): Promise<void> => {
    for (const marker of markers) {
      if (!sessions.has(marker.sessionId)) {
        await surfaces.revealSession(marker.sessionId).catch(() => null)
      }
    }
  }

  const list = async (): Promise<StructuredAgentSessionResumeCandidate[]> => {
    const markers = await readMarkers()
    await revealMarkers(markers)
    // A live chat remains an offer. The user may have opened it to inspect the context and still
    // explicitly choose whether Orca should ask the agent to continue.
    return derive(markers, 'may-be-held')
  }

  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    afterAcquire?: (marker: AgentSessionResumeMarker) => Promise<void>
  ): Promise<StructuredAgentSessionResumeOutcome[]> => {
    // An explicit action supersedes teardown witnesses captured by this host. The durable mutation
    // lane below also drains a publication already in flight before completion.
    confirmedMarkers.clear()
    teardownMarkers.clear()
    const markers = await readMarkers()
    await revealMarkers(markers)
    const requested = new Set(sessionIds ?? markers.map((marker) => marker.sessionId))
    const eligible = derive(markers, 'may-be-held').filter((candidate) =>
      requested.has(candidate.sessionId)
    )
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
    const candidates = derive(reserved, 'may-be-held')

    let outcomes: StructuredAgentSessionResumeOutcome[]
    try {
      outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          consumeMarker: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            return marker !== undefined && derive([marker], 'may-be-held').length === 1
          },
          resume: async (sessionId) => {
            const holder = `restart-resume:${sessionId}`
            try {
              await surfaces.hold(sessionId, holder)
              const marker = markersBySession.get(sessionId)
              if (marker) {
                await afterAcquire?.(marker)
              }
            } finally {
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

    const completed = outcomes
      .filter((outcome) => outcome.outcome === 'resumed')
      .map((outcome) => outcome.sessionId)
    if (deps.recoveryCapsule) {
      await enqueueRecoveryOperation(() =>
        deps.recoveryCapsule!.completeResume(operationId, completed, surfaces.now())
      ).catch(() => {
        console.warn('[structured-agent-session] restart offer completion failed')
      })
      // This only reopens rows still owned by this operation. Rows removed by completeResume stay
      // removed, even when the write of a later bookkeeping step fails.
      await enqueueRecoveryOperation(() =>
        deps.recoveryCapsule!.rollbackResume(operationId, surfaces.now())
      ).catch(() => {
        console.warn('[structured-agent-session] restart offer rollback failed')
      })
    }
    return outcomes
  }

  const continueAfterRestart = async (
    sessionIds: readonly string[] | undefined,
    owner: string
  ): Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    sessions?: StructuredAgentSessionResumeCandidate[]
  }> => {
    const continued: StructuredAgentSessionContinuationOutcome[] = []
    const resumed = await run(sessionIds, owner, async (marker) => {
      continued.push(
        await continueStructuredAgentSessionAfterRestart(
          {
            currentFence: (sessionId) => sessions.get(sessionId)?.fence ?? null,
            send: (input) =>
              surfaces.send({
                ...input,
                beforeRun: () => {
                  const options = { pendingContinuationId: input.envelope.clientOperationId }
                  if (derive([marker], 'may-be-held', options).length !== 1) {
                    throw new RestartContinuationSupersededError()
                  }
                }
              }),
            awaitSettlement: async (sessionId, clientMessageId) =>
              (await surfaces.awaitSendSettlement(sessionId, clientMessageId))?.value.submission,
            onNoteFailed: surfaces.onNoteFailed,
            note: async (sessionId, text) => {
              const session = sessions.get(sessionId)
              if (!session) {
                return
              }
              await session.journal.appendItem(
                {
                  provider: 'orca',
                  clientMessageId: `restart-continuation:${sessionId}:${surfaces.now()}`
                },
                { kind: 'status', text },
                { fence: session.fence }
              )
              surfaces.publish(sessionId, session.journal)
            }
          },
          marker.sessionId,
          marker
        )
      )
    })
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
    try {
      remainingCandidates = await list()
    } catch {
      console.warn('[structured-agent-session] restart offer refresh failed after action')
    }
    return {
      resumed,
      continued,
      ...(remainingCandidates === undefined ? {} : { sessions: remainingCandidates })
    }
  }

  return {
    captureMarkers: (trigger) => {
      confirmedMarkers.clear()
      teardownMarkers.clear()
      teardownMarkers = new Map(
        structuredAgentSessionsWorkingAtTeardown({
          sessions,
          getRecord: deps.store.getRecord,
          trigger,
          teardownId,
          now: surfaces.now()
        }).map((marker) => [marker.sessionId, marker])
      )
    },
    confirmStoppedMarker: (sessionId) => {
      const marker = teardownMarkers.get(sessionId)
      teardownMarkers.delete(sessionId)
      try {
        if (marker && derive([marker], 'may-be-held', { providerStopped: true }).length === 1) {
          confirmedMarkers.set(sessionId, marker)
        }
      } catch {
        console.warn('[structured-agent-session] recovery witness validation failed')
      }
    },
    recordMarkers: async () => {
      await enqueueRecoveryOperation(async () => {
        await deps.recoveryCapsule?.record([...confirmedMarkers.values()], surfaces.now())
      })
    },
    list,
    dismiss: async () => {
      return enqueueRecoveryOperation(async () => {
        // Do not let a teardown witness already captured in this host republish after explicit
        // dismissal. A later capture is a new interruption and may create a fresh offer normally.
        confirmedMarkers.clear()
        teardownMarkers.clear()
        return (await deps.recoveryCapsule?.clearAll(surfaces.now())) ?? 0
      })
    },
    resume: (sessionIds, owner) => run(sessionIds, owner),
    continueAfterRestart
  }
}
