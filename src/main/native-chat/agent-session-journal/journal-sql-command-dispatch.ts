import { applyJournalSqlSendAdmission } from './journal-sql-send-admission'

import { applyJournalSqlOpenCommand } from './journal-sql-open-command'

import { applyJournalDomainControlCommand } from './journal-domain-control-command'

import type Database from '../../sqlite/sync-database'

import type { JournalWriterCommand } from './journal-writer-command'

import type { JournalWriterCommit } from './journal-writer-changes'

import { finishJournalSqlCommand, journalSqlInputCoordinates } from './journal-sql-command-result'

import { applyJournalSqlItemCommand } from './journal-sql-item-command'

import { applyJournalDomainSubmission } from './journal-domain-submission-admission'

import { applyJournalDomainDispatchCommand } from './journal-domain-dispatch-command'

import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'

import { applyJournalDomainInputRecovery } from './journal-domain-input-recovery'

import { applyJournalDomainCommandTurn } from './journal-domain-command-turn'

import { applyJournalSqlContextCommand } from './journal-sql-context-command'

import { applyJournalSqlTombstoneCommand } from './journal-sql-tombstone-command'

import { applyJournalDomainGenerationSettlement } from './journal-domain-generation-settlement'

import { applyJournalDomainLifecycleOperation } from './journal-domain-taken-stop'

import { applyJournalDomainPromptMutation } from './journal-domain-prompt-mutation'

import { applyJournalSqlStepCommand } from './journal-sql-step-command'

import { applyJournalSqlEditLeaseCommand } from './journal-sql-edit-lease-command'

import { applyJournalSqlAutomaticSubmissionCommand } from './journal-sql-automatic-submission-command'

import { applyJournalSqlRewindCommand } from './journal-sql-rewind-command'

export async function runJournalSqlCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand,
  now: number
): Promise<JournalWriterCommit> {
  const savedAt = command.savedAt ?? now
  command = { ...command, savedAt }
  const { operation, target } = command
  switch (operation.kind) {
    case 'fork-install': {
      const head = db
        .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
        .get(target.sessionId, target.epoch)!
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        {
          cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
          inputChanged: true,
          items: [],
          cards: [],
          receipts: []
        },
        undefined,
        [{ kind: 'tombstone', epoch: target.epoch, seq: Number(head.last_sequence) }]
      )
    }
    case 'send-admission':
      return applyJournalSqlSendAdmission(db, stateDirectory, { ...command, operation }, savedAt)
    case 'rewind-cut':
      return applyJournalSqlRewindCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'automatic-submission':
      return applyJournalSqlAutomaticSubmissionCommand(
        db,
        stateDirectory,
        { ...command, operation },
        savedAt
      )
    case 'open':
      return applyJournalSqlOpenCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'edit-lease':
      return applyJournalSqlEditLeaseCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'item':
    case 'item-claiming':
      return applyJournalSqlItemCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'submission': {
      if (!command.facts) {
        throw new Error('journal submission omitted its identity facts')
      }
      const result = applyJournalDomainSubmission(
        db,
        stateDirectory,
        target,
        operation,
        command.facts,
        savedAt
      )
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        journalSqlInputCoordinates(target.epoch, result.coordinates),
        result.items.map((item) => item.itemId)
      )
    }
    case 'handover':
    case 'dispatch':
    case 'accept-late':
    case 'late-dispatch': {
      const result = applyJournalDomainDispatchCommand(db, target, operation, savedAt)
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        journalSqlInputCoordinates(target.epoch, result.coordinates),
        [...result.items.map((item) => item.itemId), ...result.removedItemIds]
      )
    }
    case 'pending-unknown':
    case 'pending-reject':
    case 'queued-reject':
    case 'hold-unsent':
    case 'command-open':
    case 'command-settle': {
      const result =
        operation.kind === 'command-open' || operation.kind === 'command-settle'
          ? applyJournalDomainCommandTurn(db, target, operation, savedAt, command.facts?.stopSettle)
          : applyJournalDomainInputRecovery(db, target, operation, command.facts ?? {}, savedAt)
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        result.coordinates.map((position) => ({
          kind:
            position.kind === 'queue-reopen'
              ? 'tombstone'
              : position.kind === 'command-settle'
                ? 'lifecycle-batch'
                : position.kind,
          epoch: target.epoch,
          seq: position.cursor.sequence
        })),
        [...result.items.map((item) => item.itemId), ...result.removedItemIds]
      )
    }
    case 'context-clear':
    case 'context-rewind':
    case 'epoch-replace':
      return applyJournalSqlContextCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'tombstone':
    case 'goal-withdraw':
      return applyJournalSqlTombstoneCommand(db, stateDirectory, { ...command, operation }, savedAt)
    case 'queue-insert':
    case 'queue-update':
    case 'queue-hold':
    case 'queue-withdraw':
    case 'queue-move': {
      const result = applyJournalDomainQueueCommand(db, stateDirectory, target, operation, savedAt)
      const value =
        result.result.kind === 'queue-insert'
          ? result.result.card
          : result.result.kind === 'queue-update'
            ? result.result.update
            : result.result.kind === 'queue-move'
              ? result.result.move
              : result.result.kind === 'queue-withdraw'
                ? result.result.cards
                : undefined
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        { ...result, items: [], receipts: [] },
        value,
        result.inputChanged
          ? [{ kind: 'queue', epoch: target.epoch, seq: result.cursor.sequence }]
          : []
      )
    }
    case 'lifecycle':
    case 'stale-settle':
    case 'dead-generation-settle':
    case 'unheld-turns-settle':
    case 'start-failure-settle': {
      if (command.effects) {
        throw new Error('journal settlement batches carry no receipt')
      }
      const result =
        operation.kind === 'lifecycle'
          ? applyJournalDomainLifecycleOperation(
              db,
              target,
              operation,
              savedAt,
              command.facts?.stopSettle
            )
          : applyJournalDomainGenerationSettlement(
              db,
              target,
              operation,
              savedAt,
              command.facts?.stopSettle
            )
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        result.coordinates,
        [...result.items.map((item) => item.itemId), ...result.removedItemIds]
      )
    }
    case 'prompt-mutate': {
      const result = applyJournalDomainPromptMutation(
        db,
        target,
        operation.input,
        savedAt,
        command.facts?.stopSettle
      )
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        result.coordinates,
        result.items.map((item) => item.itemId)
      )
    }
    case 'stop':
    case 'stop-accept':
    case 'queue-resume':
    case 'queue-reopen':
    case 'queue-reopen-mark':
    case 'shutdown-cut': {
      const result = applyJournalDomainControlCommand(
        db,
        target,
        operation,
        command.facts ?? {},
        savedAt
      )
      return finishJournalSqlCommand(
        db,
        stateDirectory,
        command,
        result,
        result.value,
        result.coordinates,
        [...result.items.map((item) => item.itemId), ...result.removedItemIds]
      )
    }
    case 'steps':
      return applyJournalSqlStepCommand(db, stateDirectory, { ...command, operation }, savedAt)
  }
}
