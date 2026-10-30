import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PENDING_MESSAGE_QUESTION,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import {
  messageQuestionOccurrenceId,
  messageQuestionSourceId,
  type MessageQuestionSource
} from './message-question-source'
import {
  invalidateMessageQuestionSession,
  messageQuestionsFor
} from './message-question-repository'

let root: string
let database: JournalHostDatabase
const source: MessageQuestionSource = {
  kind: 'transcript',
  agent: 'codex',
  sessionId: 'session-1',
  filePath: '/fixture/rollout.jsonl'
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-message-questions-'))
  database = JournalHostDatabase.open(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  database.close()
  await rm(root, { recursive: true, force: true })
})

function occurrence(
  row: string,
  order: number,
  overrides: Partial<MessageQuestionOccurrence> = {},
  owner = source
): MessageQuestionOccurrence {
  const sourceId = messageQuestionSourceId(owner)
  const context = 'context-1'
  return {
    id: messageQuestionOccurrenceId(sourceId, context, row, 0),
    sourceId,
    context,
    sourceRowId: row,
    callSlot: 0,
    order: [order, 0],
    timestamp: null,
    turnId: null,
    responseMode: 'message',
    questions: [
      {
        question: 'Which color?',
        multiSelect: false,
        options: [{ label: 'Blue' }, { label: 'Red' }]
      }
    ],
    resolution: PENDING_MESSAGE_QUESTION,
    ...overrides
  }
}

it('keeps exactly the cancelled call terminal through definition edits, replay and database reopen', () => {
  let repository = messageQuestionsFor(database)
  const q1 = occurrence('row-1', 1)
  const q2 = occurrence('row-2', 2)
  const secondCall = occurrence('row-1', 1, {
    callSlot: 1,
    id: messageQuestionOccurrenceId(q1.sourceId, q1.context, q1.sourceRowId, 1)
  })
  expect(repository.reconcile(source, [q1, secondCall]).writeError).toBeUndefined()
  repository.cancel(source, [q1.id], 'phone-1', 10)
  repository.reconcile(source, [q2])
  expect(repository.current(source).pending.map((row) => row.id)).toEqual([secondCall.id, q2.id])
  const corrected = {
    ...q1,
    questions: [
      {
        question: 'Which shade?',
        multiSelect: true,
        options: [{ label: 'Green', description: 'Bright' }]
      }
    ]
  }
  repository.reconcile(source, [corrected, secondCall, q2])
  database.close()
  database = JournalHostDatabase.open(root)
  repository = messageQuestionsFor(database)
  repository.reconcile(source, [corrected, secondCall, q2])
  expect(repository.current(source).records.find((row) => row.id === q1.id)).toMatchObject({
    questions: corrected.questions,
    resolution: { state: 'cancelled', reason: 'user', resolvedBy: 'phone-1', resolvedAt: 10 }
  })
  expect(repository.current(source).pending.map((row) => row.id)).toEqual([secondCall.id, q2.id])
  const stable = repository.current(source)
  expect(repository.cancel(source, [q1.id, q1.id], 'desktop-1', 20)).toBe(stable)
})

it('validates every Cancel target before changing any record, without inventing unknown targets', () => {
  const repository = messageQuestionsFor(database)
  const q1 = occurrence('row-1', 1)
  repository.reconcile(source, [q1])
  const other: MessageQuestionSource = { ...source, sessionId: 'other-session' }
  const foreign = occurrence('foreign', 1, {}, other)
  repository.reconcile(other, [foreign])
  for (const invalid of ['unknown', foreign.id]) {
    expect(() => repository.cancel(source, [q1.id, invalid], 'phone', 10)).toThrow(
      'does not belong'
    )
    expect(repository.current(source).pending.map((row) => row.id)).toEqual([q1.id])
  }
  expect(() => repository.cancel(source, [q1.id], '', 10)).toThrow('authenticated')
  expect(
    database.db.prepare('SELECT occurrence_id FROM message_question_occurrences').all()
  ).toHaveLength(2)
})

it('reconciles causal Stop and delivery without letting late old work cancel a later question', () => {
  const repository = messageQuestionsFor(database)
  const q1 = occurrence('old-question', 1, { turnId: 'T1' })
  const q2 = occurrence('later-question', 3, { turnId: 'T2' })
  const late = occurrence('late-old-question', 4, { turnId: 'T1' })
  const facts = {
    interruptedTurns: new Map([['T1', { id: 'stop-T1', at: 10 }]]),
    delivered: new Map([['context-1', { id: 'delivered-U2', at: 20, order: [2, 0] as const }]])
  }
  repository.reconcile(source, [q1, q2, late], facts)
  expect(repository.current(source).pending.map((row) => row.id)).toEqual([q2.id])
  repository.reconcile(source, [q1, q2, late])
  expect(repository.current(source).pending.map((row) => row.id)).toEqual([q2.id])
  repository.cancel(source, [q2.id], 'phone', 30)
  repository.reconcile(source, [], {
    delivered: new Map([['context-1', { id: 'answer', at: 40, order: [5, 0] as const }]])
  })
  expect(
    repository.current(source).records.find((row) => row.id === q2.id)?.resolution.reason
  ).toBe('user')
})

it('commits source linkage with creation and repairs failed canonical settlement without publishing saved pending', () => {
  const repository = messageQuestionsFor(database)
  const q = occurrence('question', 1)
  const state = { generation: 'generation-1', file: null }
  const transaction = vi.spyOn(database, 'transaction').mockImplementationOnce((run) => {
    database.db.exec('BEGIN IMMEDIATE')
    try {
      run(database.db)
      throw new Error('injected commit failure')
    } finally {
      database.db.exec('ROLLBACK')
    }
  })
  const failed = repository.reconcile(source, [q], {}, state)
  expect(failed.writeError).toBeInstanceOf(Error)
  expect(failed.incomplete).toBe(true)
  expect(failed.snapshot.records).toEqual([])
  expect(repository.sourceState(source)).toBeNull()
  expect(
    database.db.prepare('SELECT occurrence_id FROM message_question_occurrences').all()
  ).toEqual([])
  transaction.mockRestore()
  repository.reconcile(source, [q], {}, state)
  const facts = {
    delivered: new Map([['context-1', { id: 'delivered', at: 20, order: [2, 0] as const }]])
  }
  const failSettlement = vi.spyOn(database, 'transaction').mockImplementationOnce(() => {
    throw new Error('disk busy')
  })
  const effective = repository.reconcile(source, [], facts)
  expect(effective.writeError).toBeInstanceOf(Error)
  expect(effective.incomplete).toBeUndefined()
  expect(effective.snapshot.pending).toEqual([])
  expect(repository.current(source).pending).toHaveLength(1)
  failSettlement.mockRestore()
  expect(repository.reconcile(source, [], facts).writeError).toBeUndefined()
  database.close()
  database = JournalHostDatabase.open(root)
  expect(messageQuestionsFor(database).current(source).pending).toEqual([])
})

it.each([40, 400])(
  'keeps %i pending definitions untouched on unchanged reads and source-only appends',
  (count) => {
    const repository = messageQuestionsFor(database)
    const questions = Array.from({ length: count }, (_, index) => occurrence(`q-${index}`, index))
    repository.reconcile(source, questions)
    const before = repository.current(source)
    const serialize = vi.spyOn(JSON, 'stringify')
    const query = vi.spyOn(database.db, 'prepare')
    for (let index = 0; index < 10; index++) {
      expect(repository.current(source)).toBe(before)
      expect(
        repository.reconcile(
          source,
          [],
          {},
          {
            generation: 'generation-1',
            file: {
              identity: 'file',
              size: index,
              mtimeMs: index,
              ctimeMs: 0,
              offset: index,
              boundary: 'tail'
            }
          }
        ).snapshot
      ).toBe(before)
    }
    expect(
      serialize.mock.calls.filter(
        ([value]) => value && typeof value === 'object' && 'questions' in value
      )
    ).toHaveLength(0)
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT occurrence_id'))).toHaveLength(
      0
    )
    serialize.mockRestore()
    query.mockRestore()
    const changed = occurrence('new-question', count)
    repository.reconcile(source, [changed])
    expect(repository.current(source)).not.toBe(before)
    expect(repository.current(source).pending).toHaveLength(count + 1)
  }
)

it('retains terminal linkage until explicit history/source or managed-owner deletion', () => {
  const repository = messageQuestionsFor(database)
  const terminal = occurrence('terminal-question', 1)
  repository.reconcile(source, [terminal])
  repository.cancel(source, [terminal.id], 'phone', 10)
  repository.reconcile(source, [])
  expect(repository.current(source).records).toHaveLength(1)
  const managed: MessageQuestionSource = {
    kind: 'structured',
    agent: 'codex',
    sessionId: 'managed'
  }
  database.db
    .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
    .run(managed.sessionId, '{}')
  repository.reconcile(managed, [occurrence('managed-question', 1, {}, managed)])
  database.transaction((db) => {
    invalidateMessageQuestionSession(db, managed.sessionId)
    db.prepare('DELETE FROM agent_session_records WHERE session_id = ?').run(managed.sessionId)
  })
  expect(repository.current(managed).records).toEqual([])
  expect(repository.current(source).records).toHaveLength(1)
  repository.deleteSource(source)
  expect(repository.current(source).records).toEqual([])
})
