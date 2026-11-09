import { beginJournalRequestEvents } from './journal-writer-request-events'
import { applyJournalDomainControlCommand } from './journal-domain-control-command'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import { finishJournalSqlCommand, journalSqlInputCoordinates } from './journal-sql-command-result'
import { applyJournalSqlItemCommand } from './journal-sql-item-command'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'
import { applyJournalDomainInputRecovery } from './journal-domain-input-recovery'
import { applyJournalDomainCommandTurn } from './journal-domain-command-turn'
import { applyJournalDomainContextCommand } from './journal-domain-context-command'
import { applyJournalSqlTombstoneCommand } from './journal-sql-tombstone-command'
import { applyJournalDomainGenerationSettlement } from './journal-domain-generation-settlement'
import { applyJournalDomainLifecycleOperation } from './journal-domain-taken-stop'
import { applyJournalDomainPromptMutation } from './journal-domain-prompt-mutation'
import { applyJournalSqlStepCommand } from './journal-sql-step-command'
import { applyJournalSqlEditLeaseCommand } from './journal-sql-edit-lease-command'
import { applyJournalSqlAutomaticSubmissionCommand } from './journal-sql-automatic-submission-command'

/** Every command decides against current rows at its position on the sole writer. */
export class JournalSqlCommand {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string
  ) {}

  async apply(command: JournalWriterCommand, now: number): Promise<JournalWriterCommit> {
    const finish = beginJournalRequestEvents(this.db, command.facts?.stopSettle)
    try {
      const commit = await this.run(command, now)
      const requestEvents = finish()
      return {
        ...commit,
        requestEvents:
          command.operation.kind === 'epoch-replace' || command.operation.kind === 'context-rewind'
            ? []
            : requestEvents
      }
    } finally {
      finish()
    }
  }

  private async run(command: JournalWriterCommand, now: number): Promise<JournalWriterCommit> {
    const { db, stateDirectory } = this
    const savedAt = command.savedAt ?? now
    command = { ...command, savedAt }
    const { operation, target } = command
    switch (operation.kind) {
      case 'automatic-submission':
        return applyJournalSqlAutomaticSubmissionCommand(
          db,
          stateDirectory,
          { ...command, operation },
          savedAt
        )
      case 'open':
      case 'edit-lease':
        return applyJournalSqlEditLeaseCommand(
          db,
          stateDirectory,
          { ...command, operation },
          savedAt
        )
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
      case 'dispatch':
      case 'accept-late':
      case 'late-dispatch': {
        const result = applyJournalDomainDispatch(db, target, operation, savedAt)
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
            ? applyJournalDomainCommandTurn(
                db,
                target,
                operation,
                savedAt,
                command.facts?.stopSettle
              )
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
      case 'epoch-replace': {
        if (operation.kind === 'epoch-replace' && !operation.providerHandle && !command.facts) {
          throw new Error('journal context replacement omitted its identity facts')
        }
        const result = applyJournalDomainContextCommand(
          db,
          target,
          operation.kind === 'epoch-replace'
            ? {
                ...operation,
                providerHandle:
                  operation.providerHandle ??
                  agentSessionJournalProviderHandle(command.facts!.identity)
              }
            : operation,
          savedAt,
          command.facts?.stopSettle
        )
        return finishJournalSqlCommand(
          db,
          stateDirectory,
          command,
          result,
          result.cursor,
          result.coordinates.map((position) => ({
            kind:
              position.kind === 'context-item' || position.kind === 'replacement-item'
                ? 'item'
                : 'tombstone',
            epoch: position.cursor.epoch,
            seq: position.cursor.sequence
          })),
          [...result.items.map((item) => item.itemId), ...result.removedItemIds]
        )
      }
      case 'tombstone':
      case 'goal-withdraw':
        return applyJournalSqlTombstoneCommand(
          db,
          stateDirectory,
          { ...command, operation },
          savedAt
        )
      case 'queue-insert':
      case 'queue-update':
      case 'queue-hold':
      case 'queue-withdraw':
      case 'queue-move': {
        const result = applyJournalDomainQueueCommand(
          db,
          stateDirectory,
          target,
          operation,
          savedAt
        )
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
      default:
        throw new Error(`journal command ${operation.kind} is not migrated`)
    }
  }
}
