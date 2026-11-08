import { journalDomainPublicCursor } from './journal-domain-context-replacement'
import { claimJournalSqlItemInputs } from './journal-sql-item-claims'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit, JournalWriterPublication } from './journal-writer-changes'
import { applyJournalWriterEffect, type JournalWriterCoordinate } from './journal-writer-effects'

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
  const effects =
    coordinates.length > 0
      ? (command.effects ?? []).map((effect) =>
          applyJournalWriterEffect(db, stateDirectory, effect, publicCoordinates)
        )
      : []
  const publication = {
    ...result,
    cursor,
    receipts: result.receipts.map((receipt) => ({
      ...receipt,
      cursor: { ...receipt.cursor, epoch: cursor.epoch }
    })),
    invalidatedItemIds,
    referencedUploads: claims.referencedUploads
  }
  return {
    cursor,
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
    publication,
    value: publicJournalSqlValue(command, value, cursor),
    ...('goals' in claims ? { goals: claims.goals } : {}),
    effects,
    ...(coordinates.length > 0 && command.effects ? { receiptWritten: true as const } : {})
  }
}

function publicJournalSqlValue(
  command: JournalWriterCommand,
  value: unknown,
  cursor: AgentJournalCursor
): unknown {
  switch (command.operation.kind) {
    case 'item':
    case 'item-claiming':
    case 'prompt-mutate':
    case 'steps':
      return value && typeof value === 'object' ? { ...value, cursor } : value
    case 'submission':
    case 'dispatch':
    case 'lifecycle':
    case 'tombstone':
      return value == null ? value : cursor
    default:
      return value
  }
}
