import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import {
  publishCollaborationMessage,
  type PublishCollaborationInput
} from './collaboration-publish-store'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'
import { COLLABORATION_MESSAGE_PAYLOAD_VERSION } from './collaboration-message-payload'

function createRunWithTasks(
  db: OrchestrationDb,
  taskCount: number
): { runId: string; taskIds: string[] } {
  const run = db.createRun({
    objective: 'publish collaboration messages',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: 'tab_a:leaf_a'
  })
  const taskIds = Array.from(
    { length: taskCount },
    () => db.createTask({ spec: 'task', runId: run.id }).id
  )
  return { runId: run.id, taskIds }
}

function baseInput(
  runId: string,
  producerTaskId: string,
  subscriberTaskIds: readonly string[]
): PublishCollaborationInput {
  return {
    runId,
    publicationId: 'publication-1',
    producerTaskId,
    subscriberTaskIds,
    topic: 'feature-a',
    semanticType: 'status',
    priority: 'high',
    body: 'hello subscribers'
  }
}

describe('publishCollaborationMessage', () => {
  it('persists one MessageRow per subscriber with collaboration contract fields', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 3)
      const [producer, sub1, sub2] = taskIds

      const rows = publishCollaborationMessage(db, baseInput(runId, producer, [sub1, sub2]))

      expect(rows).toHaveLength(2)
      const row = rows[0]
      expect(row.run_id).toBe(runId)
      expect(row.from_handle).toBe(buildCollaborationTaskMailboxAddress(producer))
      expect(row.to_handle).toBe(buildCollaborationTaskMailboxAddress(sub1))
      expect(row.subject).toBe('status')
      expect(row.body).toBe('hello subscribers')
      expect(row.type).toBe('status')
      expect(row.priority).toBe('high')
      expect(row.thread_id).toBe('publication-1')
      expect(row.delivery_contract).toBe('current_delivery')
      expect(row.payload).toBe(
        JSON.stringify({
          version: COLLABORATION_MESSAGE_PAYLOAD_VERSION,
          topic: 'feature-a',
          semanticType: 'status',
          producerTaskId: producer
        })
      )
      expect(rows[1].to_handle).toBe(buildCollaborationTaskMailboxAddress(sub2))

      // Visible in each subscriber's mailbox
      expect(db.getAllMessages(buildCollaborationTaskMailboxAddress(sub1))).toHaveLength(1)
      expect(db.getAllMessages(buildCollaborationTaskMailboxAddress(sub2))).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('returns [] when there are no subscribers', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 1)
      const rows = publishCollaborationMessage(db, baseInput(runId, taskIds[0], []))
      expect(rows).toEqual([])
    } finally {
      db.close()
    }
  })

  it('dedupes subscriberTaskIds preserving first-seen order', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 4)
      const [producer, sub1, sub2] = taskIds

      const rows = publishCollaborationMessage(
        db,
        baseInput(runId, producer, [sub1, sub2, sub1, sub2])
      )

      expect(rows.map((r) => r.to_handle)).toEqual([
        buildCollaborationTaskMailboxAddress(sub1),
        buildCollaborationTaskMailboxAddress(sub2)
      ])
      expect(db.getAllMessages(buildCollaborationTaskMailboxAddress(sub1))).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('throws when the producer task does not exist', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 1)
      expect(() =>
        publishCollaborationMessage(db, baseInput(runId, 'missing-task', [taskIds[0]]))
      ).toThrow(/producer task missing-task/i)
    } finally {
      db.close()
    }
  })

  it('throws when the producer task belongs to a different run', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId } = createRunWithTasks(db, 1)
      const other = createRunWithTasks(db, 1)
      expect(() => publishCollaborationMessage(db, baseInput(runId, other.taskIds[0], []))).toThrow(
        /must belong to run/
      )
    } finally {
      db.close()
    }
  })

  it('prevalidates every subscriber before any insert', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, sub1] = taskIds
      const other = createRunWithTasks(db, 1)

      expect(() =>
        publishCollaborationMessage(db, baseInput(runId, producer, [sub1, other.taskIds[0]]))
      ).toThrow(/subscriber task .* must belong to run/i)

      // First subscriber was prevalidated, so nothing was inserted
      expect(db.getAllMessages(buildCollaborationTaskMailboxAddress(sub1))).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('throws when a subscriber task does not exist', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 1)
      expect(() =>
        publishCollaborationMessage(db, baseInput(runId, taskIds[0], ['missing-subscriber']))
      ).toThrow(/subscriber task missing-subscriber/i)
    } finally {
      db.close()
    }
  })
})
