import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('OrchestrationDb mutation and question state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('durable mutation receipts', () => {
    it('replays completed input and rejects request ID reuse with changed input', () => {
      const d = createDb()
      const started = d.beginMutationReceipt({
        callerFingerprint: 'caller_a',
        requestId: 'request_1',
        method: 'orchestration.send',
        payloadHash: 'hash_a'
      })
      expect(started.disposition).toBe('started')

      d.completeMutationReceipt({
        callerFingerprint: 'caller_a',
        requestId: 'request_1',
        method: 'orchestration.send',
        payloadHash: 'hash_a',
        receipt: '{"messageId":"msg_1"}'
      })
      expect(
        d.beginMutationReceipt({
          callerFingerprint: 'caller_a',
          requestId: 'request_1',
          method: 'orchestration.send',
          payloadHash: 'hash_a'
        })
      ).toMatchObject({
        disposition: 'completed',
        row: { receipt: '{"messageId":"msg_1"}' }
      })

      expect(() =>
        d.beginMutationReceipt({
          callerFingerprint: 'caller_a',
          requestId: 'request_1',
          method: 'orchestration.send',
          payloadHash: 'hash_b'
        })
      ).toThrow('already used with different input')
    })

    it('keeps caller namespaces separate and can discard only pending work', () => {
      const d = createDb()
      for (const callerFingerprint of ['caller_a', 'caller_b']) {
        d.beginMutationReceipt({
          callerFingerprint,
          requestId: 'same_request',
          method: 'orchestration.send',
          payloadHash: 'same_hash'
        })
      }
      expect(d.getMutationReceipt('caller_a', 'same_request')?.state).toBe('pending')
      expect(d.getMutationReceipt('caller_b', 'same_request')?.state).toBe('pending')

      d.discardPendingMutationReceipt('caller_a', 'same_request')
      expect(d.getMutationReceipt('caller_a', 'same_request')).toBeUndefined()
      expect(d.getMutationReceipt('caller_b', 'same_request')?.state).toBe('pending')
    })
  })

  describe('question threads', () => {
    it('accepts a question message in the fresh canonical schema', () => {
      const d = createDb()
      const message = d.insertMessage({
        from: 'worker',
        to: 'run:run_1',
        subject: 'Need input',
        type: 'question'
      })

      expect(message.type).toBe('question')
    })

    it('uses the original message ID and records one durable answer', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'Questions',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const task = d.createTask({ spec: 'ask', runId: run.id })
      const dispatch = createRootDispatch(d, task.id, 'term_worker')
      const created = d.createQuestion({
        runId: run.id,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Which format?',
        options: ['old', 'new']
      })

      expect(created.question.message_id).toBe(created.message.id)
      expect(created.message).toMatchObject({
        run_id: run.id,
        to_handle: `run:${run.id}`,
        type: 'question',
        thread_id: created.message.id
      })
      const answer = d.answerQuestion({
        messageId: created.message.id,
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        body: 'old'
      })
      const replay = d.answerQuestion({
        messageId: created.message.id,
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        body: 'old'
      })

      expect(answer.message.to_handle).toBe(`dispatch:${dispatch.id}`)
      expect(answer.question.status).toBe('answered')
      expect(replay.message.id).toBe(answer.message.id)
      expect(replay.duplicate).toBe(true)
      expect(() =>
        d.answerQuestion({
          messageId: created.message.id,
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          body: 'new'
        })
      ).toThrow(/different answer/)
    })

    it('closes pending questions with their Dispatch', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'Close questions',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const task = d.createTask({ spec: 'ask', runId: run.id })
      const dispatch = createRootDispatch(d, task.id, 'term_worker')
      const created = d.createQuestion({
        runId: run.id,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Still active?'
      })

      expect(d.closeQuestionsForDispatch(dispatch.id)).toEqual([created.message.id])
      expect(d.getQuestion(created.message.id)?.status).toBe('closed')
      expect(() =>
        d.answerQuestion({
          messageId: created.message.id,
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          body: 'late'
        })
      ).toThrow(/inactive/)
    })
  })
})
