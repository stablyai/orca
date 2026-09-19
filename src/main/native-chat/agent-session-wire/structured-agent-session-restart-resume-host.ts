// Recovery offers live in memory only after an atomic take of the advisory capsule.
// A crash after take loses the offer; ordinary chat acquisition remains independent.

import { randomUUID } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import {
  latestStructuredAgentSessionPrompt,
  latestStructuredAgentSessionUserItem,
  newestStructuredAgentSessionTurn,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumeCandidate
} from './structured-agent-session-restart-resume-set'
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

/** The host capabilities this needs, named so the collaborator cannot quietly grow more. */
export type StructuredAgentSessionRestartResumeSurfaces = {
  publish: (sessionId: string, journal: AgentSessionJournal) => void
  revealSession: (sessionId: string) => Promise<{ readable: boolean }>
  /** The resume-capable hold; see the runner for why a hold and not a send. */
  hold: (sessionId: string, holderId: string) => Promise<void>
  release: (sessionId: string, holderId: string) => void
  /** The host's own send. Reached ONLY from `continueAfterRestart` — `resume` never calls it, which
   *  is what makes "automatic reconnect can never continue" structural.
   *
   *  Typed against the wire result rather than a hand-written subset: an narrower local shape hid
   *  `value.submission` here once, and the continuation reads it. */
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  /** The host's existing settlement waiter. A send resolves while its dispatch is still pending, so
   *  this is what turns that starting state into a verdict. */
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  /** Where a failed journal note is reported. */
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
  /** Reconnect, then ask each reconnected agent to carry on. A deliberate user action only. */
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string
  ) => Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
  }>
  dismiss: () => Promise<number>
}

export function createStructuredAgentSessionRestartResume(
  deps: {
    store: AgentSessionRecordStore
    adapter: StructuredAgentSessionAdapter
    recoveryCapsule?: Pick<AgentSessionRecoveryCapsule, 'take' | 'record'>
  },
  /** The host's LIVE session map — the only honest answer to "was this actually working". */
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const teardownId = randomUUID()
  let teardownMarkers = new Map<string, AgentSessionResumeMarker>()
  const confirmedMarkers = new Map<string, AgentSessionResumeMarker>()
  let claimed: AgentSessionResumeMarker[] | null = null
  let claiming: Promise<void> | undefined

  const claimMarkers = async (): Promise<AgentSessionResumeMarker[]> => {
    claiming ??= (async () => {
      try {
        claimed = (await deps.recoveryCapsule?.take(surfaces.now())) ?? []
      } catch {
        console.warn('[structured-agent-session] taking recovery capsule failed')
        claimed = []
      }
    })()
    await claiming
    return claimed ?? []
  }

  /** Spends one claimed marker. In memory, because the durable copy is already gone. */
  const spendClaimed = (sessionId: string): boolean => {
    const before = claimed?.length ?? 0
    claimed = (claimed ?? []).filter((marker) => marker.sessionId !== sessionId)
    return claimed.length < before
  }

  /** Opens any claimed session this launch has not, so its journal can answer for itself. An
   *  unreadable journal leaves the predicate with one record instead of two, which refuses. */
  const revealClaimed = async (): Promise<AgentSessionResumeMarker[]> => {
    const markers = await claimMarkers()
    for (const marker of markers) {
      if (!sessions.has(marker.sessionId)) {
        await surfaces.revealSession(marker.sessionId).catch(() => null)
      }
    }
    return markers
  }

  const derive = (
    markers: readonly AgentSessionResumeMarker[],
    leaseState: 'must-be-released' | 'may-be-held',
    providerStopped = false,
    pendingContinuationId?: string
  ): StructuredAgentSessionResumeCandidate[] => {
    const items = new Map<string, AgentJournalRenderItem[]>()
    const itemsFor = (sessionId: string): AgentJournalRenderItem[] => {
      let snapshot = items.get(sessionId)
      if (!snapshot) {
        snapshot = sessions.get(sessionId)?.journal.snapshot().items ?? []
        if (pendingContinuationId) {
          const ownItemId = agentJournalSubmissionKey(pendingContinuationId)
          snapshot = snapshot.filter((item) => item.itemId !== ownItemId)
        }
        items.set(sessionId, snapshot)
      }
      return snapshot
    }
    return structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.store.getRecord,
      supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
      waitingOnUser: (sessionId) =>
        projectStructuredAgentSessionStatus(itemsFor(sessionId)) === 'attention',
      providerStopped,
      journalTurn: (sessionId) => newestStructuredAgentSessionTurn(itemsFor(sessionId)),
      journalSubmission: (sessionId, clientMessageId) =>
        sessions
          .get(sessionId)
          ?.journal.submissions()
          .find((submission) => submission.clientMessageId === clientMessageId) ?? null,
      latestPrompt: (sessionId) => latestStructuredAgentSessionPrompt(itemsFor(sessionId)),
      latestUserItemId: (sessionId) =>
        latestStructuredAgentSessionUserItem(itemsFor(sessionId))?.itemId ?? null,
      now: surfaces.now(),
      leaseState
    })
  }

  const list = async (): Promise<StructuredAgentSessionResumeCandidate[]> =>
    derive(await revealClaimed(), 'must-be-released')

  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    afterAcquire?: (marker: AgentSessionResumeMarker) => Promise<void>
  ): Promise<StructuredAgentSessionResumeOutcome[]> => {
    const markers = await revealClaimed()
    const requested = new Set(sessionIds ?? markers.map((entry) => entry.sessionId))
    // Re-derived at CLICK time, never taken from the caller: a client may name any session id,
    // and only the predicate decides which of them is allowed a provider child.
    const released = new Set(derive(markers, 'must-be-released').map((entry) => entry.sessionId))
    const candidates = derive(markers, 'may-be-held').filter(
      (candidate) =>
        requested.has(candidate.sessionId) &&
        (released.has(candidate.sessionId) ||
          sessions.get(candidate.sessionId)?.hasProviderChild === true)
    )
    const markersBySession = new Map(markers.map((marker) => [marker.sessionId, marker]))
    return resumeStructuredAgentSessionsFromRestart(
      {
        admission,
        consumeMarker: async (sessionId) => {
          const marker = markersBySession.get(sessionId)
          const leaseState =
            sessions.get(sessionId)?.hasProviderChild === true ? 'may-be-held' : 'must-be-released'
          return !!marker && derive([marker], leaseState).length === 1 && spendClaimed(sessionId)
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
            // Pane holds and active turns take over; otherwise the normal idle grace applies.
            surfaces.release(sessionId, holder)
          }
        }
      },
      candidates,
      owner
    )
  }

  /** Reconnect first, then send. Continuation is a message ON TOP of a reconnect and reuses every
   *  guard the resume path applies — eligibility, the admission gate, staggering, consume-once —
   *  rather than re-deriving any of them. A session that did not reconnect is never sent to. */
  const continueAfterRestart = async (
    sessionIds: readonly string[] | undefined,
    owner: string
  ): Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
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
                // The pending continuation itself is not newer user work.
                beforeRun: () => {
                  if (
                    derive([marker], 'may-be-held', false, input.envelope.clientOperationId)
                      .length !== 1
                  ) {
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
    return { resumed, continued }
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
      // Eviction has stopped the provider and drained its tail, but has not cancelled prompts yet.
      teardownMarkers.delete(sessionId)
      try {
        if (marker && derive([marker], 'may-be-held', true).length === 1) {
          confirmedMarkers.set(sessionId, marker)
        }
      } catch {
        console.warn('[structured-agent-session] recovery witness validation failed')
      }
    },
    recordMarkers: async () =>
      deps.recoveryCapsule?.record([...confirmedMarkers.values()], surfaces.now()),
    list,
    /**
     * Turning the offer down, which spends the claim.
     *
     * A prompt that returns at every launch is worse than the problem it solves. Nothing is lost:
     * the first resume-capable hold on a childless session re-acquires the provider at the same
     * proved cursor, so opening the chat still reconnects it. The durable markers are already gone
     * — the claim deleted them — so this only has to empty the launch-scoped set.
     */
    dismiss: async () => {
      const markers = await claimMarkers()
      const spent = markers.length
      claimed = []
      return spent
    },
    resume: (sessionIds, owner) => run(sessionIds, owner),
    continueAfterRestart
  }
}
