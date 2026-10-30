import type Database from '../sqlite/sync-database'
import {
  messageQuestionOccurrenceSchema,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import { compareMessageQuestionOrder } from './message-question-lifecycle'

export type MessageQuestionSnapshot = {
  records: readonly MessageQuestionOccurrence[]
  pending: readonly MessageQuestionOccurrence[]
}
export type StoredSource = { snapshot: MessageQuestionSnapshot; json: ReadonlyMap<string, string> }
export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('Unreadable message question record')
  }
  return JSON.parse(value)
}

export function snapshot(records: Iterable<MessageQuestionOccurrence>): MessageQuestionSnapshot {
  const ordered = [...records].sort(
    (a, b) =>
      compareMessageQuestionOrder(a.order, b.order) ||
      a.callSlot - b.callSlot ||
      a.id.localeCompare(b.id)
  )
  return {
    records: ordered,
    pending: ordered.filter((record) => record.resolution.state === 'pending')
  }
}

export function readMessageQuestionSource(db: Database.Database, sourceId: string): StoredSource {
  const records: MessageQuestionOccurrence[] = []
  const json = new Map<string, string>()
  for (const row of db
    .prepare(
      'SELECT occurrence_id, record_json FROM message_question_occurrences WHERE source_id = ?'
    )
    .all(sourceId)) {
    const record = messageQuestionOccurrenceSchema.parse(parseJson(row.record_json))
    if (
      record.sourceId !== sourceId ||
      record.id !== row.occurrence_id ||
      typeof row.record_json !== 'string'
    ) {
      throw new Error('Message question source mismatch')
    }
    records.push(record)
    json.set(record.id, row.record_json)
  }
  return { snapshot: snapshot(records), json }
}
