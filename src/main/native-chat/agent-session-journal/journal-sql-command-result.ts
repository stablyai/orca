import { journalDomainPublicCursor } from './journal-domain-context-replacement'
import { claimJournalSqlItemInputs } from './journal-sql-item-claims'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit, JournalWriterPublication } from './journal-writer-changes'
import { applyJournalWriterEffect, type JournalWriterCoordinate } from './journal-writer-effects'
import { readJournalDomainQueueRevision } from './journal-domain-queue-revision'

export function finishJournalSqlCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand,
  result: JournalWriterPublication & {
    cursor: JournalWriterCommit['cursor']
    publicCursor?: AgentJournalCursor
    inputChanged: boolean
  },
  value: unknown,
  coordinates: readonly JournalWriterCoordinate[],
  invalidatedItemIds: string[] = []
): JournalWriterCommit {
  const physicalEpoch = coordinates.at(-1)?.epoch ?? command.target.epoch
  const cursor =
    result.publicCursor ??
    (result.cursor.epoch !== physicalEpoch
      ? result.cursor
      : journalDomainPublicCursor(
          db,
          { sessionId: command.target.sessionId, epoch: physicalEpoch },
          result.cursor.sequence
        ))
  const publicCoordinates = coordinates.map((position) => ({ ...position, epoch: cursor.epoch }))
  const claims =
    coordinates.length > 0
      ? claimJournalSqlItemInputs(db, stateDirectory, command, result)
      : { referencedUploads: result.referencedUploads ?? [] }
  const receiptWritten =
    coordinates.length > 0 ||
    command.effects?.some(
      (effect) => effect.kind === 'store' && effect.mutation.input.kind === 'rewind-complete'
    )
  const effects = receiptWritten
    ? (command.effects ?? []).map((effect) =>
        applyJournalWriterEffect(db, stateDirectory, effect, publicCoordinates)
      )
    : []
  const publication = {
    ...result,
    ...(command.operation.kind === 'epoch-replace' ? { resetPrompts: true as const } : {}),
    cursor,
    receipts: result.receipts.map((receipt) => ({
      ...receipt,
      cursor: { ...receipt.cursor, epoch: cursor.epoch }
    })),
    invalidatedItemIds,
    referencedUploads: claims.referencedUploads
  }
  const queue = readJournalDomainQueueRevision(db, command.target.sessionId)
  return {
    cursor,
    inputChanged:
      result.inputChanged ||
      coordinates.some(
        (position) => position.epoch === queue.epoch && position.seq === queue.revision
      ),
    queueRevision: `${queue.epoch}:${queue.revision}`,
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
    publication,
    value: publicJournalSqlValue(command, value, cursor),
    ...('goals' in claims ? { goals: claims.goals } : {}),
    effects,
    ...(receiptWritten && command.effects ? { receiptWritten: true as const } : {})
  }
}

function publicJournalSqlValue(
  command: JournalWriterCommand,
  value: unknown,
  cursor: AgentJournalCursor
): unknown {
  const operation = command.operation.kind
  if (operation === 'lifecycle' && command.operation.takenStop) {
    return value
  }
  if (
    operation === 'item' ||
    operation === 'item-claiming' ||
    operation === 'prompt-mutate' ||
    operation === 'steps' ||
    operation === 'shutdown-cut'
  ) {
    return value && typeof value === 'object' ? { ...value, cursor } : value
  }
  if (
    operation === 'submission' ||
    operation === 'dispatch' ||
    operation === 'lifecycle' ||
    operation === 'tombstone' ||
    operation === 'goal-withdraw' ||
    operation === 'context-clear' ||
    operation === 'context-rewind' ||
    operation === 'rewind-cut' ||
    operation === 'epoch-replace' ||
    operation === 'stop' ||
    operation === 'queue-resume' ||
    operation === 'queue-reopen'
  ) {
    return value == null ? value : cursor
  }
  if (operation === 'stop-accept' && value && typeof value === 'object') {
    return { ...value, mark: cursor }
  }
  return value
}

export function journalSqlInputCoordinates(
  epoch: string,
  positions: readonly {
    kind: 'submission' | 'dispatch' | 'queue-reopen'
    cursor: AgentJournalCursor
  }[]
): JournalWriterCoordinate[] {
  return positions.map((position) => ({
    kind: position.kind === 'queue-reopen' ? 'tombstone' : position.kind,
    epoch,
    seq: position.cursor.sequence
  }))
}
