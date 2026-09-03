import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import {
  findMissingCollaborationTopics,
  hasCollaborationTopicPublished
} from './collaboration-publication-facts'
import { COLLABORATION_MESSAGE_PAYLOAD_VERSION } from './collaboration-message-payload'
import { publishCollaborationMessage } from './collaboration-publish-store'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'

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

function publish(
  db: OrchestrationDb,
  runId: string,
  producerTaskId: string,
  subscriberTaskIds: readonly string[],
  topic: string
): void {
  publishCollaborationMessage(db, {
    runId,
    publicationId: 'publication-1',
    producerTaskId,
    subscriberTaskIds,
    topic,
    semanticType: 'status',
    priority: 'high',
    body: 'hello'
  })
}

describe('hasCollaborationTopicPublished', () => {
  it('returns false before the topic has been published', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer] = taskIds
      expect(
        hasCollaborationTopicPublished(db, { runId, producerTaskId: producer, topic: 'feature-a' })
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it('returns true after the producer publishes the topic', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, subscriber] = taskIds
      publish(db, runId, producer, [subscriber], 'feature-a')
      expect(
        hasCollaborationTopicPublished(db, { runId, producerTaskId: producer, topic: 'feature-a' })
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('still counts the topic after the subscriber marks the message as read', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, subscriber] = taskIds
      const [row] = publishCollaborationMessage(db, {
        runId,
        publicationId: 'publication-1',
        producerTaskId: producer,
        subscriberTaskIds: [subscriber],
        topic: 'feature-a',
        semanticType: 'status',
        priority: 'high',
        body: 'hello'
      })
      db.markAsRead([row.id])
      expect(
        hasCollaborationTopicPublished(db, { runId, producerTaskId: producer, topic: 'feature-a' })
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns false for another run, task, or topic', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, otherProducer] = taskIds
      const other = createRunWithTasks(db, 1)
      publish(db, runId, producer, [otherProducer], 'feature-a')

      expect(
        hasCollaborationTopicPublished(db, { runId, producerTaskId: producer, topic: 'feature-b' })
      ).toBe(false)
      expect(
        hasCollaborationTopicPublished(db, {
          runId,
          producerTaskId: otherProducer,
          topic: 'feature-a'
        })
      ).toBe(false)
      expect(
        hasCollaborationTopicPublished(db, {
          runId: other.runId,
          producerTaskId: producer,
          topic: 'feature-a'
        })
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it('returns false for a foreign non-collaboration payload from the same handle', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, subscriber] = taskIds
      db.insertMessage({
        runId,
        from: buildCollaborationTaskMailboxAddress(producer),
        to: buildCollaborationTaskMailboxAddress(subscriber),
        subject: 'status',
        type: 'status',
        priority: 'high',
        threadId: 'publication-1',
        body: 'foreign',
        payload: JSON.stringify({
          version: COLLABORATION_MESSAGE_PAYLOAD_VERSION + 99,
          topic: 'feature-a'
        }),
        deliveryContract: 'current_delivery'
      })
      expect(
        hasCollaborationTopicPublished(db, { runId, producerTaskId: producer, topic: 'feature-a' })
      ).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('findMissingCollaborationTopics', () => {
  it('returns all required topics when none are published', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 1)
      const [producer] = taskIds
      const required = ['feature-a', 'feature-b', 'feature-c']
      expect(
        findMissingCollaborationTopics(db, {
          runId,
          producerTaskId: producer,
          requiredTopics: required
        })
      ).toEqual(required)
    } finally {
      db.close()
    }
  })

  it('returns only the missing topics, preserving input order', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, subscriber] = taskIds
      publish(db, runId, producer, [subscriber], 'feature-b')
      publish(db, runId, producer, [subscriber], 'feature-d')
      const required = ['feature-a', 'feature-b', 'feature-c', 'feature-d', 'feature-e']
      expect(
        findMissingCollaborationTopics(db, {
          runId,
          producerTaskId: producer,
          requiredTopics: required
        })
      ).toEqual(['feature-a', 'feature-c', 'feature-e'])
    } finally {
      db.close()
    }
  })

  it('returns [] when every required topic is published', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { runId, taskIds } = createRunWithTasks(db, 2)
      const [producer, subscriber] = taskIds
      publish(db, runId, producer, [subscriber], 'feature-a')
      publish(db, runId, producer, [subscriber], 'feature-b')
      expect(
        findMissingCollaborationTopics(db, {
          runId,
          producerTaskId: producer,
          requiredTopics: ['feature-a', 'feature-b']
        })
      ).toEqual([])
    } finally {
      db.close()
    }
  })
})
