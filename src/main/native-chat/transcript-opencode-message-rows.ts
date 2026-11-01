import type { OpenCodeTranscriptItem } from './transcript-opencode-sqlite-query'
import { zcodeTranscriptOrder } from '../ai-vault/session-scanner-zcode-order'
import { extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import type SyncDatabase from '../sqlite/sync-database'
import { rowsWithinBudget } from './transcript-opencode-row-budget'
import {
  opencodeMessages,
  OPENCODE_TRANSCRIPT_MAX_ROW_BYTES
} from './transcript-opencode-part-blocks'
export const PART_ID_BATCH = 100

export type MessageRow = {
  message_rowid: number
  transcript_order: number
  id: string
  time_created: number
  time_updated: number
  data: string | null
}

export type PartRow = {
  message_id: string
  time_updated: number
  data: string | null
}

export function mapMessageRows(
  db: SyncDatabase,
  sessionId: string,
  rows: MessageRow[],
  rawBudget: { bytes: number },
  agent?: 'zcode'
): OpenCodeTranscriptItem[] {
  if (rows.length === 0) {
    return []
  }
  const partsByMessage = new Map<string, PartRow[]>()
  const ids = rows.map((row) => row.id)
  for (let start = 0; start < ids.length; start += PART_ID_BATCH) {
    const batch = ids.slice(start, start + PART_ID_BATCH)
    const placeholders = batch.map(() => '?').join(', ')
    const partRows = rowsWithinBudget<PartRow>(
      db.prepare(
        `SELECT message_id, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ${OPENCODE_TRANSCRIPT_MAX_ROW_BYTES} THEN data ELSE NULL END AS data FROM part p
         WHERE session_id = ? AND message_id IN (${placeholders})
         ORDER BY ${agent === 'zcode' ? zcodeTranscriptOrder(db, agent, 'part', 'p', 'ASC') : 'rowid'} LIMIT 10001`
      ),
      rawBudget,
      sessionId,
      ...batch
    )
    if (partRows.length > 10000) {
      throw new Error('OpenCode transcript parts exceed their read limit')
    }
    for (const partRow of partRows) {
      const list = partsByMessage.get(partRow.message_id)
      if (list) {
        list.push(partRow)
      } else {
        partsByMessage.set(partRow.message_id, [partRow])
      }
    }
  }
  const items: OpenCodeTranscriptItem[] = []
  for (const row of rows) {
    const partList = partsByMessage.get(row.id) ?? []
    const record = row.data === null ? null : parseJsonObject(row.data)
    const role = extractString(record?.role)
    const messages = opencodeMessages(
      {
        id: row.id,
        role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system',
        timestamp: Number.isFinite(row.time_created) ? row.time_created : null
      },
      row.data === null
        ? [{ message_id: row.id, time_updated: row.time_updated, data: null }]
        : partList
    )
    const updated = partList.reduce(
      (max, row) => (row.time_updated > max ? row.time_updated : max),
      0
    )
    for (const message of messages.toReversed()) {
      items.push({
        rowid: row.message_rowid,
        fingerprint: `${row.time_updated}:${partList.length}:${updated}`,
        message: {
          ...message,
          transcriptOffset: row.message_rowid,
          ...(agent === 'zcode' ? { transcriptOrder: row.transcript_order } : {})
        }
      })
    }
  }
  return items
}
