import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import type { MessageInsert } from '../orchestration/db/messages/message-insert'
import type { MessagePriority, MessageRow } from '../orchestration/types'
import {
  COLLABORATION_MESSAGE_PAYLOAD_VERSION,
  encodeCollaborationMessagePayload
} from './collaboration-message-payload'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'

export type PublishCollaborationInput = {
  runId: string
  publicationId: string
  producerTaskId: string
  subscriberTaskIds: readonly string[]
  topic: string
  semanticType: string
  priority: MessagePriority
  body: string
}

function requireTaskInRun(db: OrchestrationDb, taskId: string, runId: string, role: string): void {
  const task = db.getTask(taskId)
  if (!task) {
    throw new Error(`${role} task ${taskId} not found`)
  }
  if (task.run_id !== runId) {
    throw new Error(`${role} task ${taskId} must belong to run ${runId}`)
  }
}

// Why: persist one collaboration message per subscriber in the orchestration DB;
// no routing, notify, or receipt logic here — callers decide what the messages mean.
export function publishCollaborationMessage(
  db: OrchestrationDb,
  input: PublishCollaborationInput
): MessageRow[] {
  requireTaskInRun(db, input.producerTaskId, input.runId, 'Producer')

  const subscriberTaskIds = [...new Set(input.subscriberTaskIds)]
  for (const subscriberTaskId of subscriberTaskIds) {
    requireTaskInRun(db, subscriberTaskId, input.runId, 'Subscriber')
  }

  if (subscriberTaskIds.length === 0) {
    return []
  }

  const from = buildCollaborationTaskMailboxAddress(input.producerTaskId)
  const payload = encodeCollaborationMessagePayload({
    version: COLLABORATION_MESSAGE_PAYLOAD_VERSION,
    topic: input.topic,
    semanticType: input.semanticType,
    producerTaskId: input.producerTaskId
  })
  const messages: MessageInsert[] = subscriberTaskIds.map((subscriberTaskId) => ({
    runId: input.runId,
    from,
    to: buildCollaborationTaskMailboxAddress(subscriberTaskId),
    subject: input.semanticType,
    body: input.body,
    type: 'status',
    priority: input.priority,
    threadId: input.publicationId,
    payload,
    deliveryContract: 'current_delivery'
  }))
  return db.insertMessages(messages)
}
