import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit, JournalWriterPublication } from './journal-writer-changes'
import { applyJournalWriterEffect, type JournalWriterCoordinate } from './journal-writer-effects'
import { applyJournalDomainItem } from './journal-domain-item'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'
import { applyJournalSqlMessageSteps, type JournalSqlMessage } from './journal-sql-message-commit'

/** Every command decides against current rows at its position on the sole writer. */
export class JournalSqlCommand {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string
  ) {}

  async apply(command: JournalWriterCommand, now: number): Promise<JournalWriterCommit> {
    if (!this.db.isTransaction) {
      throw new Error('journal SQL command requires its transaction')
    }
    const savedAt = command.savedAt ?? now
    const { operation, target } = command
    switch (operation.kind) {
      case 'item':
      case 'item-claiming': {
        const result = applyJournalDomainItem(
          this.db,
          target,
          { ...operation, kind: 'item' },
          savedAt
        )
        const itemId = agentJournalItemKey(operation.identity)
        const written = result.items.find((item) => item.itemId === itemId) ?? result.items[0]
        return this.finish(
          command,
          result,
          written
            ? {
                cursor: result.cursor,
                itemId: written.itemId,
                revision: written.revision
              }
            : null,
          result.outcome.kind === 'committed' && result.outcome.wrote
            ? [
                {
                  kind: 'item',
                  epoch: target.epoch,
                  seq: result.cursor.sequence
                }
              ]
            : [],
          result.items.map((item) => item.itemId)
        )
      }
      case 'submission': {
        if (!command.facts) {
          throw new Error('journal submission omitted its identity facts')
        }
        const result = applyJournalDomainSubmission(
          this.db,
          this.stateDirectory,
          target,
          operation,
          command.facts,
          savedAt
        )
        return this.finish(
          command,
          result,
          result.value,
          result.coordinates.map((position) => ({
            kind: position.kind === 'queue-reopen' ? 'tombstone' : position.kind,
            epoch: target.epoch,
            seq: position.cursor.sequence
          })),
          result.items.map((item) => item.itemId)
        )
      }
      case 'dispatch':
      case 'accept-late':
      case 'late-dispatch': {
        const result = applyJournalDomainDispatch(this.db, target, operation, savedAt)
        return this.finish(
          command,
          result,
          result.value,
          result.coordinates.map((position) => ({
            kind: position.kind === 'queue-reopen' ? 'tombstone' : position.kind,
            epoch: target.epoch,
            seq: position.cursor.sequence
          })),
          [...result.items.map((item) => item.itemId), ...result.removedItemIds]
        )
      }
      case 'queue-insert':
      case 'queue-update':
      case 'queue-hold':
      case 'queue-withdraw':
      case 'queue-move': {
        const result = applyJournalDomainQueueCommand(
          this.db,
          this.stateDirectory,
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
        return this.finish(
          command,
          { ...result, items: [], receipts: [] },
          value,
          result.inputChanged
            ? [{ kind: 'queue', epoch: target.epoch, seq: result.cursor.sequence }]
            : []
        )
      }
      case 'steps': {
        const text = textSteps(operation.steps)
        if (!text) {
          throw new Error('journal non-text steps are not migrated')
        }
        const result = applyJournalSqlMessageSteps(this.db, {
          target,
          steps: operation.dropped ? [] : text,
          savedAt
        })
        if (operation.dropped) {
          result.outcomes = text.map(() => ({ kind: 'dropped' }))
        }
        return this.finish(
          command,
          result,
          {
            outcomes: result.outcomes,
            cursor: result.cursor,
            items: result.items,
            ...(result.failure ? { failure: result.failure } : {})
          },
          []
        )
      }
      default:
        throw new Error(`journal command ${operation.kind} is not migrated`)
    }
  }

  private finish(
    command: JournalWriterCommand,
    result: JournalWriterPublication & {
      cursor: JournalWriterCommit['cursor']
      inputChanged: boolean
    },
    value: unknown,
    coordinates: readonly JournalWriterCoordinate[],
    invalidatedItemIds: string[] = []
  ): JournalWriterCommit {
    const effects =
      coordinates.length > 0
        ? (command.effects ?? []).map((effect) =>
            applyJournalWriterEffect(this.db, this.stateDirectory, effect, coordinates)
          )
        : []
    return {
      cursor: result.cursor,
      inputChanged: result.inputChanged,
      keys: [],
      inputKeys: [],
      items: [
        ...result.items.map((item) => ({
          itemId: item.itemId,
          deleted: false as const,
          revision: item.revision,
          sequence: item.sequence,
          sequenceIndex: item.sequenceIndex ?? 0
        })),
        ...(result.removedItemIds ?? []).map((itemId) => ({
          itemId,
          deleted: true as const,
          revision: 0
        }))
      ],
      publication: { ...result, invalidatedItemIds },
      value,
      effects,
      ...(coordinates.length > 0 && command.effects ? { receiptWritten: true as const } : {})
    }
  }
}

function textSteps(
  steps: Extract<JournalWriterCommand['operation'], { kind: 'steps' }>['steps']
): JournalSqlMessage[] | null {
  if (steps.length === 0) {
    return null
  }
  const messages: JournalSqlMessage[] = []
  for (const step of steps) {
    if (step.kind !== 'resolved-item' || step.resolution.kind !== 'text-snapshot') {
      return null
    }
    messages.push({ ...step.resolution, options: step.options })
  }
  return messages
}
