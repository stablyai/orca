import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import type { MessagePriority } from '../orchestration/types'
import {
  ackCollaborationCheckpoint,
  prepareCollaborationCheckpoint,
  type CollaborationCheckpointEntry
} from './collaboration-checkpoint-store'
import { buildCollaborationTaskMailboxAddress } from './collaboration-task-mailbox'
import { encodeCollaborationMessagePayload } from './collaboration-message-payload'
import type { AdmissionPolicy } from './collaboration-admission'

function insertCollaborationMessage(
  db: OrchestrationDb,
  taskId: string,
  input: {
    id?: string
    topic: string
    semanticType: string
    producerTaskId: string
    priority?: MessagePriority
  }
): string {
  const row = db.insertMessage({
    id: input.id,
    from: input.producerTaskId,
    to: buildCollaborationTaskMailboxAddress(taskId),
    subject: input.topic,
    body: `body:${input.topic}`,
    type: 'status',
    priority: input.priority ?? 'normal',
    payload: encodeCollaborationMessagePayload({
      version: 1,
      topic: input.topic,
      semanticType: input.semanticType,
      producerTaskId: input.producerTaskId
    })
  })
  return row.id
}

// malformed: not JSON at all; foreign: JSON but not a collaboration payload; unknown-version: right shape, wrong version
function insertNonCollaborationMessage(
  db: OrchestrationDb,
  taskId: string,
  id: string,
  kind: 'malformed' | 'foreign' | 'unknown-version'
): string {
  const payload =
    kind === 'malformed'
      ? 'not-json'
      : kind === 'foreign'
        ? JSON.stringify({ version: 1, topic: 'x' })
        : JSON.stringify({ version: 99, topic: 'x', semanticType: 'y', producerTaskId: 'z' })
  return db.insertMessage({
    id,
    from: 'worker',
    to: buildCollaborationTaskMailboxAddress(taskId),
    subject: 'not collaboration',
    body: 'garbage',
    type: 'status',
    payload
  }).id
}

const policy: AdmissionPolicy = {
  acceptedTypes: ['checkpoint', 'milestone'],
  minPriority: 'high'
}

function assertEntryShape(entry: CollaborationCheckpointEntry): void {
  expect(entry).toMatchObject({
    messageId: expect.any(String),
    topic: expect.any(String),
    semanticType: expect.any(String),
    producerTaskId: expect.any(String),
    priority: expect.any(String),
    body: expect.any(String)
  })
  expect(entry).not.toHaveProperty('filteredMessageIds')
}

describe('prepareCollaborationCheckpoint', () => {
  it('returns { entries, filteredMessageIds } preserving admission priority order', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'worker-1',
      priority: 'high'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'm2',
      topic: 'done',
      semanticType: 'milestone',
      producerTaskId: 'worker-2',
      priority: 'urgent'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'm3',
      topic: 'low',
      semanticType: 'checkpoint',
      producerTaskId: 'worker-3',
      priority: 'normal'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'm4',
      topic: 'banner',
      semanticType: 'banner',
      producerTaskId: 'worker-4',
      priority: 'urgent'
    })

    const result = prepareCollaborationCheckpoint(db, taskId, policy)

    expect(result.entries.map((e) => e.messageId)).toEqual(['m2', 'm1'])
    expect(result.entries[0]).toEqual({
      messageId: 'm2',
      topic: 'done',
      semanticType: 'milestone',
      producerTaskId: 'worker-2',
      priority: 'urgent',
      body: 'body:done'
    })
    expect(result.entries[1]).toEqual({
      messageId: 'm1',
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'worker-1',
      priority: 'high',
      body: 'body:progress'
    })
    expect(result.filteredMessageIds).toEqual(['m3', 'm4'])
  })

  it('marks filtered ids read immediately and leaves accepted entries unread until ack', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'accepted',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'filtered-low',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'normal'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'filtered-type',
      topic: 't',
      semanticType: 'banner',
      producerTaskId: 'w1',
      priority: 'urgent'
    })

    const first = prepareCollaborationCheckpoint(db, taskId, policy)

    expect(first.entries.map((e) => e.messageId)).toEqual(['accepted'])
    expect(first.filteredMessageIds).toEqual(['filtered-low', 'filtered-type'])
    expect(db.getMessageById('accepted')?.read).toBe(0)
    expect(db.getMessageById('filtered-low')?.read).toBe(1)
    expect(db.getMessageById('filtered-type')?.read).toBe(1)

    // accepted stay unread and are re-surfaced until acked
    expect(ackCollaborationCheckpoint(db, taskId, ['accepted'])).toBe(false)
    expect(prepareCollaborationCheckpoint(db, taskId, policy)).toEqual({
      entries: [],
      filteredMessageIds: []
    })
  })

  it('ignores malformed, foreign, and unknown-version payload rows: left unread, not filtered', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertNonCollaborationMessage(db, taskId, 'bad-malformed', 'malformed')
    insertCollaborationMessage(db, taskId, {
      id: 'valid',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    insertNonCollaborationMessage(db, taskId, 'bad-foreign', 'foreign')
    insertNonCollaborationMessage(db, taskId, 'bad-version', 'unknown-version')

    const result = prepareCollaborationCheckpoint(db, taskId, policy)

    expect(result.entries.map((e) => e.messageId)).toEqual(['valid'])
    expect(result.filteredMessageIds).toEqual([])
    expect(db.getMessageById('bad-malformed')?.read).toBe(0)
    expect(db.getMessageById('bad-foreign')?.read).toBe(0)
    expect(db.getMessageById('bad-version')?.read).toBe(0)
    expect(db.getMessageById('valid')?.read).toBe(0)
  })

  it('applies the optional limit to recognized rows only, so unknown rows do not starve valid entries', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertNonCollaborationMessage(db, taskId, 'unknown-1', 'foreign')
    for (let i = 0; i < 3; i++) {
      insertCollaborationMessage(db, taskId, {
        id: `m${i}`,
        topic: `t${i}`,
        semanticType: 'checkpoint',
        producerTaskId: 'w1',
        priority: 'urgent'
      })
    }
    insertNonCollaborationMessage(db, taskId, 'unknown-2', 'malformed')

    const limited = prepareCollaborationCheckpoint(db, taskId, policy, 2)

    expect(limited.entries.map((e) => e.messageId)).toEqual(['m0', 'm1'])
    expect(limited.filteredMessageIds).toEqual([])
    expect(db.getMessageById('m2')?.read).toBe(0)
    expect(db.getMessageById('unknown-1')?.read).toBe(0)
    expect(db.getMessageById('unknown-2')?.read).toBe(0)

    ackCollaborationCheckpoint(db, taskId, ['m0', 'm1'])
    const rest = prepareCollaborationCheckpoint(db, taskId, policy)
    expect(rest.entries.map((e) => e.messageId)).toEqual(['m2'])
  })

  it('closes admission when acceptedTypes is empty, filtering everything valid', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    insertNonCollaborationMessage(db, taskId, 'bad', 'foreign')

    const result = prepareCollaborationCheckpoint(db, taskId, {
      acceptedTypes: [],
      minPriority: 'normal'
    })

    expect(result).toEqual({ entries: [], filteredMessageIds: ['m1'] })
    expect(db.getMessageById('m1')?.read).toBe(1)
    expect(db.getMessageById('bad')?.read).toBe(0)
  })

  it('returns an empty result for an empty mailbox', () => {
    const db = new OrchestrationDb(':memory:')
    expect(prepareCollaborationCheckpoint(db, 'task-a', policy)).toEqual({
      entries: [],
      filteredMessageIds: []
    })
  })

  it('does not touch messages in other mailboxes', () => {
    const db = new OrchestrationDb(':memory:')
    insertCollaborationMessage(db, 'task-other', {
      id: 'other',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })

    const result = prepareCollaborationCheckpoint(db, 'task-a', policy)

    expect(result).toEqual({ entries: [], filteredMessageIds: [] })
    expect(db.getMessageById('other')?.read).toBe(0)
    expect(db.getMessageById('other')?.to_handle).toBe('collaboration-task:task-other')
  })

  it('shapes every returned entry correctly', () => {
    const db = new OrchestrationDb(':memory:')
    insertCollaborationMessage(db, 'task-a', {
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    const result = prepareCollaborationCheckpoint(db, 'task-a', policy)
    expect(result.entries).toHaveLength(1)
    assertEntryShape(result.entries[0])
  })
})

describe('ackCollaborationCheckpoint', () => {
  it('marks unread ids read and returns duplicate false', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    prepareCollaborationCheckpoint(db, taskId, policy)

    expect(ackCollaborationCheckpoint(db, taskId, ['m1'])).toBe(false)
    expect(db.getMessageById('m1')?.read).toBe(1)
  })

  it('returns duplicate true when all ids are already read but belong to the mailbox', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    prepareCollaborationCheckpoint(db, taskId, policy)
    ackCollaborationCheckpoint(db, taskId, ['m1'])

    expect(ackCollaborationCheckpoint(db, taskId, ['m1'])).toBe(true)
    expect(db.getMessageById('m1')?.read).toBe(1)
  })

  it('rejects a mix of read and unread ids without marking anything', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    insertCollaborationMessage(db, taskId, {
      id: 'm2',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    prepareCollaborationCheckpoint(db, taskId, policy)
    db.markAsRead(['m1'])

    expect(() => ackCollaborationCheckpoint(db, taskId, ['m1', 'm2'])).toThrow()
    expect(db.getMessageById('m2')?.read).toBe(0)
  })

  it('rejects ids that do not exist without marking anything', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, taskId, {
      id: 'm1',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })
    prepareCollaborationCheckpoint(db, taskId, policy)

    expect(() => ackCollaborationCheckpoint(db, taskId, ['missing'])).toThrow()
    expect(db.getMessageById('m1')?.read).toBe(0)
  })

  it('rejects ids belonging to a different mailbox without marking anything', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertCollaborationMessage(db, 'task-other', {
      id: 'other',
      topic: 't',
      semanticType: 'checkpoint',
      producerTaskId: 'w1',
      priority: 'urgent'
    })

    expect(() => ackCollaborationCheckpoint(db, taskId, ['other'])).toThrow()
    expect(db.getMessageById('other')?.read).toBe(0)
  })

  it('rejects ids whose payload is not a valid collaboration payload, even in the same mailbox', () => {
    const db = new OrchestrationDb(':memory:')
    const taskId = 'task-a'
    insertNonCollaborationMessage(db, taskId, 'bad-malformed', 'malformed')
    insertNonCollaborationMessage(db, taskId, 'bad-foreign', 'foreign')
    insertNonCollaborationMessage(db, taskId, 'bad-version', 'unknown-version')

    expect(() => ackCollaborationCheckpoint(db, taskId, ['bad-malformed'])).toThrow()
    expect(() => ackCollaborationCheckpoint(db, taskId, ['bad-foreign'])).toThrow()
    expect(() => ackCollaborationCheckpoint(db, taskId, ['bad-version'])).toThrow()
    expect(db.getMessageById('bad-malformed')?.read).toBe(0)
    expect(db.getMessageById('bad-foreign')?.read).toBe(0)
    expect(db.getMessageById('bad-version')?.read).toBe(0)
  })

  it('rejects an empty id list', () => {
    const db = new OrchestrationDb(':memory:')
    expect(() => ackCollaborationCheckpoint(db, 'task-a', [])).toThrow()
  })
})
