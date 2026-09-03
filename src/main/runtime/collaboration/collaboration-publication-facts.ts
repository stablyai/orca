import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { parseCollaborationMessagePayload } from './collaboration-message-payload'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'

export type CollaborationPublicationFact = {
  runId: string
  producerTaskId: string
}

// Why: derive durable completion facts straight from persisted SQL rows; a valid
// fact is a current_delivery message authored by the producer's collaboration
// mailbox in the run whose payload parses and matches producer/topic exactly.
// Read state is irrelevant — ACKed/read rows still count as published facts.
function publishedTopics(db: OrchestrationDb, runId: string, producerTaskId: string): Set<string> {
  const rows = db.db
    .prepare(
      `SELECT payload FROM messages
       WHERE delivery_contract = 'current_delivery' AND run_id = ? AND from_handle = ?`
    )
    .all(runId, buildCollaborationTaskMailboxAddress(producerTaskId)) as {
    payload: string | null
  }[]

  const topics = new Set<string>()
  for (const row of rows) {
    const payload = parseCollaborationMessagePayload(row.payload ?? '')
    if (payload === null || payload.producerTaskId !== producerTaskId) {
      continue
    }
    topics.add(payload.topic)
  }
  return topics
}

export function hasCollaborationTopicPublished(
  db: OrchestrationDb,
  fact: CollaborationPublicationFact & { topic: string }
): boolean {
  return publishedTopics(db, fact.runId, fact.producerTaskId).has(fact.topic)
}

export function findMissingCollaborationTopics(
  db: OrchestrationDb,
  fact: CollaborationPublicationFact & { requiredTopics: readonly string[] }
): string[] {
  const topics = publishedTopics(db, fact.runId, fact.producerTaskId)
  return fact.requiredTopics.filter((topic) => !topics.has(topic))
}
