import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { MessagePriority } from '../orchestration/types'
import { admitCandidates, type AdmissionPolicy } from './collaboration-admission'
import { parseCollaborationMessagePayload } from './collaboration-message-payload'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'

export type CollaborationCheckpointEntry = {
  messageId: string
  topic: string
  semanticType: string
  producerTaskId: string
  priority: MessagePriority
  body: string
}

export type CollaborationCheckpointResult = {
  entries: readonly CollaborationCheckpointEntry[]
  filteredMessageIds: readonly string[]
}

// Why: rows without a parseable collaboration payload can never be admitted, so they are ignored entirely
// (left unread, not filtered) and do not consume the optional limit.
export function prepareCollaborationCheckpoint(
  db: OrchestrationDb,
  taskId: string,
  policy: AdmissionPolicy,
  limit?: number
): CollaborationCheckpointResult {
  const address = buildCollaborationTaskMailboxAddress(taskId)
  const rows = db.getUnreadMessages(address)

  const recognized: {
    row: (typeof rows)[number]
    payload: NonNullable<ReturnType<typeof parseCollaborationMessagePayload>>
  }[] = []
  for (const row of rows) {
    const payload = parseCollaborationMessagePayload(row.payload ?? '')
    if (payload === null) {
      continue
    }
    recognized.push({ row, payload })
  }
  const considered = limit === undefined ? recognized : recognized.slice(0, limit)

  const candidates = considered.map(({ row, payload }) => ({
    id: row.id,
    message: { type: payload.semanticType, priority: row.priority }
  }))

  const { admitted, filtered } = admitCandidates(candidates, policy)
  if (filtered.length > 0) {
    db.markAsRead([...filtered])
  }

  const entryByMessageId = new Map(considered.map(({ row, payload }) => [row.id, { row, payload }]))
  const entries = admitted.map((candidate) => {
    const { row, payload } = entryByMessageId.get(candidate.id)!
    return {
      messageId: candidate.id,
      topic: payload.topic,
      semanticType: payload.semanticType,
      producerTaskId: payload.producerTaskId,
      priority: row.priority,
      body: row.body
    }
  })

  return { entries, filteredMessageIds: filtered }
}

// Why: ack confirms consumption of previously admitted entries; already-read ids mean the caller already acked them (duplicate).
export function ackCollaborationCheckpoint(
  db: OrchestrationDb,
  taskId: string,
  messageIds: readonly string[]
): boolean {
  if (messageIds.length === 0) {
    throw new OrchestrationError('invalid_argument', 'messageIds must not be empty')
  }
  const address = buildCollaborationTaskMailboxAddress(taskId)
  const rows = messageIds.map((id) => db.getMessageById(id))
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined || row.to_handle !== address) {
      throw new OrchestrationError(
        'invalid_argument',
        `message ${messageIds[i]} does not belong to mailbox ${address}`
      )
    }
    if (parseCollaborationMessagePayload(row.payload ?? '') === null) {
      throw new OrchestrationError(
        'invalid_argument',
        `message ${messageIds[i]} has no valid collaboration payload`
      )
    }
  }
  const allUnread = rows.every((row) => row!.read === 0)
  const allRead = rows.every((row) => row!.read === 1)
  if (allUnread) {
    db.markAsRead([...messageIds])
    return false
  }
  if (allRead) {
    return true
  }
  throw new OrchestrationError('invalid_argument', 'cannot ack a mix of read and unread messages')
}
