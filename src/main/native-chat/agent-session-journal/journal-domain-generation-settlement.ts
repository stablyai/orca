import type Database from '../../sqlite/sync-database'
import type { JournalWriterOperation } from './journal-writer-command'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import { planStaleStructuredAgentSessionState } from '../agent-session-wire/termination/structured-agent-session-stale-state-settlement'
import { planStructuredAgentSessionDeadGeneration } from '../agent-session-wire/termination/structured-agent-session-dead-generation-settlement'
import { runningTurnLifecycleRevisions } from '../agent-session-wire/termination/structured-agent-session-stale-turn-verdict'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { journalStartFailureRow } from './writing/journal-start-failure-settlement'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import {
  applyJournalDomainLifecycle,
  hasJournalDomainSettlement,
  journalDomainLifecycleCommit,
  type JournalDomainLifecycleCommit
} from './journal-domain-lifecycle'
import { readJournalDomainGeneration } from './journal-domain-generation-reads'
import { journalDomainTimelineReads } from './journal-domain-timeline-reads'

type Operation = Extract<
  JournalWriterOperation,
  {
    kind: 'stale-settle' | 'dead-generation-settle' | 'unheld-turns-settle' | 'start-failure-settle'
  }
>

/** No producer snapshot decides recovery: evidence is applied to the current lifecycle rows. */
export function applyJournalDomainGenerationSettlement(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  operation: Operation,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
): JournalDomainLifecycleCommit & { value: number | undefined } {
  const empty = journalDomainLifecycleCommit(db, target)
  let batch: JournalLifecycleBatchInput
  let value: number | undefined
  if (operation.kind === 'start-failure-settle') {
    const input = operation.input
    const settlementId = `start-failure:${input.startKey}`
    if (hasJournalDomainSettlement(db, target, settlementId)) {
      return { ...empty, value }
    }
    if (input.clientMessageId !== null) {
      const attempt = readJournalDomainSubmissionAttempt(db, target, input.clientMessageId)
      if (!attempt || !isQueuedAgentJournalSubmission(attempt.submission)) {
        return { ...empty, value }
      }
    }
    batch = {
      settlementId,
      fence: input.fence,
      recovered: true,
      keepFailedStart: true,
      mutations: [journalStartFailureRow(input.startKey, input)],
      dispatches:
        input.clientMessageId === null
          ? []
          : [
              {
                clientMessageId: input.clientMessageId,
                fence: input.fence,
                state: 'rejected',
                recovered: true,
                reason: input.reason,
                rejection: input.rejection
              }
            ]
    }
  } else if (operation.kind === 'unheld-turns-settle') {
    const input = operation.input
    const settlementId = `unheld-turns:${input.sessionId}:${input.fence}:${input.generation}`
    if (hasJournalDomainSettlement(db, target, settlementId)) {
      return { ...empty, value }
    }
    const view = journalDomainTimelineReads(db, target, stopSettle)
    const unheld = [...view.unsettled(null)].filter((item) => {
      const turn = readAgentJournalTurn(item.body)
      if (
        item.body.kind !== 'turn' ||
        turn?.state !== 'running' ||
        turn.turnId === input.liveTurnId ||
        !isRootAgentJournalItem(item)
      ) {
        return false
      }
      const row = db
        .prepare(
          `SELECT COALESCE(execution_owner,owner_fence) AS fence FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`
        )
        .get(target.sessionId, target.epoch, item.itemId)
      return Number(row?.fence) === input.fence
    })
    batch = {
      settlementId,
      fence: input.fence,
      recovered: true,
      mutations: runningTurnLifecycleRevisions(unheld, { state: 'interrupted' })
    }
  } else {
    const input = operation.input
    const exit = operation.kind === 'dead-generation-settle' ? operation.input.exit : undefined
    const generation =
      operation.kind === 'stale-settle'
        ? (operation.input.acquisitionGeneration ?? `seq-${empty.cursor.sequence}`)
        : `seq-${empty.cursor.sequence}`
    const settlementId = exit
      ? `dead-generation:${exit.settlementId}`
      : `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`
    if (hasJournalDomainSettlement(db, target, settlementId)) {
      return { ...empty, value: 0 }
    }
    const reads = readJournalDomainGeneration(
      db,
      target,
      exit?.exitedDuringStartup
        ? (exit.exitedDuringStartup.generation ?? exit.settlementId)
        : undefined,
      stopSettle,
      exit?.verdict.state === 'interrupted' && typeof exit.verdict.completedAt === 'number'
        ? { completedAt: exit.verdict.completedAt, ownerFence: exit.ownerFence }
        : undefined
    )
    const journal = reads
    if (operation.kind === 'stale-settle') {
      const plan = planStaleStructuredAgentSessionState({ ...operation.input, journal })
      value = plan.mutations.length
      batch = { ...operation.input, settlementId, recovered: true, ...plan }
    } else {
      const authority = operation.input
      const exited = exit
        ? planStructuredAgentSessionDeadGeneration(
            { ...exit, journal, sessionId: input.sessionId, fence: input.fence },
            (owner) => owner === undefined || owner >= exit.ownerFence,
            authority
          )
        : { mutations: [], dispatches: [] }
      const settled = new Set(exited.dispatches.map((entry) => entry.clientMessageId))
      const stale = planStaleStructuredAgentSessionState({
        ...authority,
        journal,
        acquisitionGeneration: null
      })
      const continuing = new Set(authority.continuingInputs)
      const finalizing = new Set(
        authority.finalizingInputs
          .filter((entry) => !entry.settlementOwner)
          .map((entry) => entry.clientMessageId)
      )
      const pending = new Set(
        reads.inputOrder
          .recoverableSubmissions()
          .filter((send) => send.dispatchState === 'pending')
          .map((send) => send.clientMessageId)
      )
      const mutations = [...exited.mutations, ...stale.mutations]
      const dispatches = [
        ...exited.dispatches,
        ...stale.dispatches.filter((entry) => !settled.has(entry.clientMessageId))
      ].filter(
        (entry) =>
          !(continuing.has(entry.clientMessageId) && pending.has(entry.clientMessageId)) &&
          (entry.state === 'rejected' || !finalizing.has(entry.clientMessageId))
      )
      value = mutations.length + dispatches.length
      batch = {
        settlementId,
        fence: input.fence,
        recovered: true,
        keepFailedStart: exit?.exitedDuringStartup !== undefined,
        mutations,
        dispatches
      }
    }
  }
  return { ...applyJournalDomainLifecycle(db, target, batch, savedAt, stopSettle), value }
}
