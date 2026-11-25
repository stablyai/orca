import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type Database from '../../sqlite/sync-database'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { JournalWriterOperation } from './journal-writer-command'
import type { JournalCommandOpenResult } from './journal-store-contracts'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainItem } from './journal-domain-item'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { spendJournalSqlCommandCards } from './journal-sql-message-effects'
import { journalSqlFailure } from './journal-sql-failure'
import {
  journalDomainInputCommit,
  appendJournalDomainInputCommit,
  type JournalDomainInputCommit
} from './journal-domain-input-commit'

export type JournalDomainCommandTurnOperation = Extract<
  JournalWriterOperation,
  { kind: 'command-open' | 'command-settle' }
>

/** Dispatch is a successful prefix; the following turn/result write has its own rollback boundary. */
export function applyJournalDomainCommandTurn(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: JournalDomainCommandTurnOperation,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
): JournalDomainInputCommit<JournalCommandOpenResult | undefined> {
  if (!db.isTransaction) {
    throw new Error('journal command turn requires its writer transaction')
  }
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal command turn targets a retired chat epoch')
  }
  const result = journalDomainInputCommit<JournalCommandOpenResult | undefined>(
    { epoch: target.epoch, sequence: Number(head.last_sequence) },
    undefined
  )
  const dispatch =
    operation.kind === 'command-open'
      ? { ...operation.input, state: 'pending' as const }
      : operation.input.dispatch
  const restoreDispatchEvents = checkpointJournalRequestEvents(db)
  db.exec('SAVEPOINT journal_command_dispatch')
  try {
    const commit = applyJournalDomainDispatch(
      db,
      target,
      { kind: 'dispatch', input: dispatch },
      savedAt
    )
    db.exec('RELEASE journal_command_dispatch')
    appendJournalDomainInputCommit(result, commit)
  } catch (error) {
    db.exec('ROLLBACK TO journal_command_dispatch; RELEASE journal_command_dispatch')
    restoreDispatchEvents()
    result.value = { failure: journalSqlFailure(error) }
    return result
  }
  const restoreTurnEvents = checkpointJournalRequestEvents(db)
  db.exec('SAVEPOINT journal_command_turn')
  try {
    const turn = structuredAgentSessionCommandTurn(dispatch.clientMessageId)
    if (operation.kind === 'command-open') {
      const attempt = readJournalDomainSubmissionAttempt(
        db,
        target,
        dispatch.clientMessageId,
        false
      )
      const running = agentJournalTurnBody({
        turnId: turn.turnId,
        state: 'running',
        userItemId: agentJournalSubmissionKey(dispatch.clientMessageId),
        requestedAt: attempt?.submission.handedOverAt ?? operation.input.submittedAt,
        startedAt: savedAt
      })
      const commit = applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity: turn.identity,
          body: running,
          options: {
            fence: dispatch.fence,
            observedAt: savedAt,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        },
        savedAt,
        stopSettle
      )
      const step = {
        ...commit,
        coordinates:
          commit.outcome.kind === 'committed' && commit.outcome.wrote
            ? [
                {
                  kind: 'item' as const,
                  cursor: commit.cursor,
                  fence: dispatch.fence,
                  observedAt: savedAt
                }
              ]
            : [],
        removedItemIds: []
      }
      db.exec('RELEASE journal_command_turn')
      appendJournalDomainInputCommit(result, step)
      result.value = { value: { turn, running } }
    } else {
      const previous = readJournalDomainDispatchItem(db, target, turn.itemId)
      const running = readAgentJournalTurn(previous?.item.body)
      if (!previous || running?.state !== 'running') {
        db.exec('RELEASE journal_command_turn')
        return result
      }
      const step = journalDomainInputCommit(result.cursor, undefined)
      const sequence = step.cursor.sequence + 1
      const mutations = [
        ...(dispatch.state === 'rejected' && operation.input.failureBody
          ? [
              {
                itemId: agentJournalItemKey(turn.resultIdentity),
                body: operation.input.failureBody,
                turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
              }
            ]
          : []),
        {
          itemId: turn.itemId,
          body: agentJournalTurnBody({
            ...running,
            ...(dispatch.state === 'rejected'
              ? { state: 'completed' as const, outcome: 'failure' as const, completedAt: savedAt }
              : { state: 'unverifiable' as const })
          }),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
      for (const [sequenceIndex, mutation] of mutations.entries()) {
        const stored =
          mutation.itemId === turn.itemId
            ? previous
            : readJournalDomainDispatchItem(db, target, mutation.itemId)
        const tombstone = db
          .prepare(
            'SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
          )
          .get(target.sessionId, target.epoch, mutation.itemId)
        const next: AgentJournalRenderItem = {
          ...mutation,
          revision: Math.max(stored?.item.revision ?? 0, Number(tombstone?.revision ?? 0)) + 1,
          sequence,
          ...(sequenceIndex ? { sequenceIndex } : {}),
          observedAt: savedAt
        }
        step.items.push(
          ...writeJournalDomainCurrentItem(db, target, {
            inputObservation: {
              itemId: mutation.itemId,
              seq: sequence,
              fence: dispatch.fence,
              ownerFence: stored?.ownerFence ?? dispatch.fence,
              turnScope: mutation.turnScope
            },
            item: stored ? journalItemRevisionValue(stored.item, next) : next,
            ...(stored ? { previous: stored } : {}),
            stopSettle,
            hidden: stored?.hidden ?? false,
            ownerFence: stored?.ownerFence ?? dispatch.fence,
            executionOwner: stored?.executionOwner,
            writtenSequence: sequence
          })
        )
        if (tombstone) {
          db.prepare(
            'DELETE FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
          ).run(target.sessionId, target.epoch, mutation.itemId)
        }
      }
      Object.assign(
        step,
        spendJournalSqlCommandCards(
          db,
          [target.sessionId, target.epoch],
          savedAt,
          step.items.map((item) => item.itemId)
        )
      )
      step.inputChanged = step.cards.length > 0
      appendJournalSqlEvent(
        db,
        target,
        sequence,
        savedAt,
        {
          items: step.items.map((item) => ({
            itemId: item.itemId,
            revision: item.revision,
            sequence: item.sequence,
            sequenceIndex: item.sequenceIndex ?? 0
          })),
          submissions: [],
          cards: step.cards.map((card) => card.messageId)
        },
        { fence: dispatch.fence, observedAt: savedAt }
      )
      step.cursor = { epoch: target.epoch, sequence }
      step.coordinates.push({
        kind: 'command-settle',
        cursor: step.cursor,
        fence: dispatch.fence,
        observedAt: savedAt
      })
      db.exec('RELEASE journal_command_turn')
      appendJournalDomainInputCommit(result, step)
    }
  } catch (error) {
    db.exec('ROLLBACK TO journal_command_turn; RELEASE journal_command_turn')
    restoreTurnEvents()
    result.value = { failure: journalSqlFailure(error) }
  }
  return result
}
