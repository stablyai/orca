import { createRestartEvidenceReader } from './structured-agent-session-restart-evidence'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import { createRestartSettlementReconciler } from './structured-agent-session-restart-settlement'
import { createRestartAdmission } from './structured-agent-session-restart-admission'
import { restartSendAcceptance } from './structured-agent-session-restart-send'
import { writeRestartRequestContext } from './structured-agent-session-restart-request-context'
import { journalPersonalStopEvidenceAfter } from '../../agent-session-journal/context-epochs/journal-personal-stop'
// Offers remain pending until ordinary durable send acceptance; settle exact witnesses together.

import { randomUUID } from 'node:crypto'
import { createRestartResumeProgress } from './structured-agent-session-restart-resume-progress'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import * as restartCandidates from './structured-agent-session-restart-candidates'
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
import { STRUCTURED_AGENT_SESSION_RESUME_UNKNOWN } from './structured-agent-session-restart-resume-runner'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import {
  continuationDeps,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import {
  createStructuredAgentSessionRestartOfferWithdrawal,
  type StructuredAgentSessionRestartOfferSession
} from './structured-agent-session-restart-offer-withdrawal'
import type { StructuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import * as restartResults from './structured-agent-session-restart-action-result'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

export function createStructuredAgentSessionRestartResume(
  deps: Pick<
    StructuredAgentSessionHostDeps,
    'store' | 'adapter' | 'recoveryCapsule' | 'logger' | 'agents' | 'journalDatabase'
  >,
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartOfferSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getConversation,
    childWork: surfaces.readChildWork,
    childWorkOpen: surfaces.childWorkOpen,
    childWorkAutonomous: surfaces.childWorkAutonomous,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    teardownId: randomUUID(),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const personalStopEvidence = (marker: AgentSessionResumeMarker): boolean | 'unknown' => {
    const record = deps.store.getConversation(marker.sessionId)
    if (record?.providerContextBoundary?.operationId !== marker.contextClearOperationId) {
      return false
    }
    const after = {
      cursor: marker.journalCursor,
      at: marker.recordedAt,
      ...(marker.work.kind === 'turn' ? { turnId: marker.work.id } : {})
    }
    const journal = sessions.get(marker.sessionId)?.journal
    const evidence = journal
      ? journal.recoveryPersonalStopAfter(after)
      : journalPersonalStopEvidenceAfter(deps.journalDatabase.db, marker.sessionId, after)
    return evidence === 'unknown' ? 'unknown' : evidence === 'stopped'
  }
  const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
    sessions,
    ownAttempt: (sessionId, startedFor) => recovery.owns(sessionId, startedFor),
    personallyCancelled: personalStopEvidence,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const newerOrca = restartCandidates.createNewerOrcaChats(() => deps.journalDatabase.readOnly)
  const { derive, deriveAtSend } =
    restartCandidates.createStructuredAgentSessionRestartCandidateReaders({
      sessions,
      getRecord: deps.store.getRecord,
      adapter: deps.adapter,
      agents: deps.agents,
      movedOn: withdrawal.movedOn,
      savedByNewerOrca: newerOrca.has
    })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    getRecord: deps.store.getConversation,
    evaluate: restartCandidates.failureEvaluator(personalStopEvidence, derive, withdrawal),
    savedByNewerOrca: newerOrca.has,
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })

  const { readMarkers, revealMarkers, revealEvery, retireSuperseded } =
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

  const readEvidence = createRestartEvidenceReader({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    database: deps.journalDatabase,
    loaded: (id) => sessions.has(id),
    provider: (id) => deps.store.getRecord(id)?.provider,
    logger: deps.logger,
    now: surfaces.now
  })
  const list = async (
    audience?: StructuredAgentSessionRestartAudience
  ): Promise<StructuredAgentSessionResumeCandidate[]> =>
    (await readEvidence('pending', audience, ({ pending }) => {
      const { candidates, superseded } = derive(pending, 'may-be-held')
      retireSuperseded(superseded)
      return restartRowsFor(candidates, audience)
    })) ?? []
  const listFailures = async (audience?: StructuredAgentSessionRestartAudience) =>
    (await readEvidence('failed', audience, async ({ failed }) =>
      restartRowsFor(await failures.list(failed), audience)
    )) ?? []

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

  const recovery = createRestartAdmission({
    deps,
    sessions,
    derive,
    deriveAtSend,
    revealMarkers,
    retireSuperseded,
    clearWitnesses: witnesses.clear,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })

  const continueAfterRestart: StructuredAgentSessionRestartResume['continueAfterRestart'] = async (
    sessionIds,
    owner,
    audience
  ) => {
    const progress = createRestartResumeProgress(sessions, surfaces.publishStatus)
    try {
      const continued: StructuredAgentSessionContinuationOutcome[] = []
      const verdicts: Promise<void>[] = []
      // Hold startup slots through handover/start failure, awaiting provider answers separately.
      const action = await recovery.run(
        sessionIds,
        owner,
        audience,
        async (selection, attempt) => {
          const { marker } = selection
          if (attempt.kind === 'unknown') {
            const outcome = { sessionId: marker.sessionId, outcome: 'unknown' as const }
            continued.push(outcome)
            progress.verdict(outcome)
            throw new Error(STRUCTURED_AGENT_SESSION_RESUME_UNKNOWN)
          }
          const cancelled = recovery.cancelled(marker.sessionId)
          const journal = sessions.get(marker.sessionId)?.journal
          if (journal) {
            await writeRestartRequestContext(
              deps.journalDatabase.stateDirectory,
              marker.sessionId,
              journal,
              attempt.body
            )
          }
          const stillWanted = () =>
            !recovery.stopping() && !cancelled() && continuationHost.stillResumable(marker)
          const accept = restartSendAcceptance({
            deps,
            selection,
            attempt,
            stillWanted,
            stopping: recovery.stopping,
            now: surfaces.now,
            fence: () => continuationHost.conversationFence(marker.sessionId)
          })
          const started = await startStructuredAgentSessionContinuation(
            continuationDeps(continuationHost, stillWanted, accept),
            marker.sessionId,
            marker,
            attempt.id,
            attempt.body
          )
          if ('done' in started) {
            continued.push(started.done)
            progress.verdict(started.done)
            const { outcome, reason, refusal } = started.done
            if (outcome === 'refused') {
              // Preserve refusal details beside the filed code.
              throw refusal
                ? new AgentSessionRefusalError(
                    agentSessionRefusalFromReference(refusal, refusal.code)
                  )
                : new Error(reason ?? 'agent_session_continuation_refused')
            }
            return
          }
          verdicts.push(
            started.verdict().then((outcome) => {
              continued.push(outcome)
              progress.verdict(outcome)
            })
          )
        },
        progress
      )
      await Promise.all(verdicts)
      const resumed = action?.outcomes ?? []
      if (action) {
        await failures.settleSelected(action.selections, resumed, {
          candidates: action.candidates,
          markers: action.markers,
          failureAfterResume: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome ? continuationFailureOutcome(outcome.outcome) : null
          },
          failureReason: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
          },
          reconcile: createRestartSettlementReconciler({
            store: deps.store,
            selections: action.selections,
            attempts: action.attempts,
            sessions,
            personalStop: personalStopEvidence,
            movedOn: withdrawal.movedOnWithPersonalStop
          })
        })
      }
      continued.push(...restartResults.unstartedRestartRefusals(resumed, continued))
      return {
        resumed,
        continued,
        ...(progress.skipped.length > 0 ? { skipped: progress.skipped } : {}),
        ...(await restartResults.remainingRestartRows(
          () => list(audience),
          () => listFailures(audience),
          deps.logger
        ))
      }
    } finally {
      progress.clear()
    }
  }

  return {
    beginTeardown: (trigger) => {
      recovery.stop()
      witnesses.begin(trigger)
    },
    captureBeforeStop: witnesses.beforeStop,
    confirmStopped: witnesses.stopped,
    recordMarkers: witnesses.record,
    list,
    listFailures,
    // Block old witnesses after dismissal; reveal first to preserve newer/unlisted chats.
    dismiss: (sessionIds, audience) => {
      recovery.cancel(sessionIds, audience)
      return failures.dismiss(
        sessionIds,
        async (clearAudience) => {
          witnesses.clear(clearAudience)
          await revealEvery()
        },
        audience
      )
    },
    continueAfterRestart,
    hasUnaccepted: recovery.hasUnaccepted,
    onAgentStarted: withdrawal.onAgentStarted,
    continueInterrupted: createInterruptedContinuation(continuationHost, readMarkers)
  }
}
