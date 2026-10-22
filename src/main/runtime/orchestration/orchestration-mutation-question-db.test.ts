import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('OrchestrationDb mutation and question state', () => {
  let db: OrchestrationDb | undefined
  const directories: string[] = []

  afterEach(() => {
    db?.close()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function createDb(path = ':memory:'): OrchestrationDb {
    db = new OrchestrationDb(path)
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
    function questionFixture(federated = false, path = ':memory:') {
      const d = createDb(path)
      const run = d.createRun({
        objective: 'Exact question identity',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const task = d.createTask({ spec: 'ask exactly', runId: run.id })
      const dispatch = federated
        ? d.createStartingWorkerDispatch({
            creator: { kind: 'system' },
            maxDepth: Number.MAX_SAFE_INTEGER,
            taskId: task.id,
            startOptions: {},
            federation: {
              environmentId: 'environment-worker',
              environmentName: 'worker',
              peerFingerprint: 'peer-worker',
              protocolVersion: 3
            }
          }).dispatch
        : createRootDispatch(d, task.id, 'term_worker')
      const created = d.createQuestion({
        runId: run.id,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Which format?\nPreserve this exact text.',
        options: ['old', 'new', 'custom: keep spacing  ']
      })
      const identity = {
        messageId: created.message.id,
        runId: run.id,
        taskId: task.id,
        dispatchId: dispatch.id
      }
      const answer = {
        messageId: identity.messageId,
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        expectedIdentity: { taskId: task.id, dispatchId: dispatch.id },
        body: 'old'
      }
      return { d, run, task, dispatch, created, identity, answer }
    }

    function messageIds(d: OrchestrationDb) {
      return d.db.prepare('SELECT id FROM messages ORDER BY rowid').all()
    }

    it('inspects exact original content and pending, answered and closed state', () => {
      const { d, identity, answer, created, dispatch } = questionFixture()
      const original = {
        ...created.question,
        task_id: identity.taskId,
        body: created.message.body,
        options: ['old', 'new', 'custom: keep spacing  ']
      }
      expect(d.inspectQuestion(identity)).toEqual(original)
      const answered = d.answerQuestion(answer)
      expect(d.inspectQuestion(identity)).toEqual({
        ...original,
        ...answered.question
      })
      const pending = d.createQuestion({
        runId: identity.runId,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'No options'
      })
      d.closeQuestionsForDispatch(dispatch.id)
      expect(d.inspectQuestion({ ...identity, messageId: pending.message.id })).toMatchObject({
        status: 'closed',
        body: 'No options',
        options: [],
        task_id: identity.taskId
      })
      expect(d.inspectQuestion({ ...identity, messageId: pending.message.id }).closed_at).toMatch(
        /Z$/
      )
    })

    it.each(['runId', 'taskId', 'dispatchId'] as const)(
      'rejects wrong %s on inspect and strict answer without inserting messages',
      (field) => {
        const { d, identity, answer } = questionFixture()
        const before = messageIds(d)
        const wrong = { ...identity, [field]: 'wrong_identity' }
        expect(() => d.inspectQuestion(wrong)).toThrowError(
          expect.objectContaining({ code: 'request_mismatch' })
        )
        const wrongAnswer = {
          ...answer,
          runId: wrong.runId,
          expectedIdentity: { taskId: wrong.taskId, dispatchId: wrong.dispatchId }
        }
        if (field === 'runId') {
          const otherRun = d.createRun({
            objective: 'Other run',
            coordinatorHandle: 'term_other',
            coordinatorPaneKey: 'tab_other:22222222-2222-4222-8222-222222222222'
          })
          wrongAnswer.runId = otherRun.id
          wrongAnswer.consumerGeneration = otherRun.consumer_generation
        }
        expect(() => d.answerQuestion(wrongAnswer)).toThrowError(
          expect.objectContaining({ code: 'request_mismatch' })
        )
        expect(d.getQuestion(identity.messageId)?.status).toBe('pending')
        expect(messageIds(d)).toEqual(before)
      }
    )

    it('rejects missing questions and ordinary messages without inserting answers', () => {
      const { d, identity, answer } = questionFixture()
      const ordinary = d.insertMessage({
        from: `run:${identity.runId}`,
        to: `dispatch:${identity.dispatchId}`,
        subject: 'Ordinary message',
        body: 'Not a question',
        runId: identity.runId
      })
      const before = messageIds(d)
      for (const messageId of ['missing_question', ordinary.id]) {
        expect(() => d.inspectQuestion({ ...identity, messageId })).toThrowError(
          expect.objectContaining({ code: 'question_not_found' })
        )
        expect(() => d.answerQuestion({ ...answer, messageId })).toThrowError(
          expect.objectContaining({ code: 'question_not_found' })
        )
      }
      expect(messageIds(d)).toEqual(before)
    })

    it('rejects closed questions and conflicting answers while replaying the original after settlement', () => {
      const { d, identity, answer, dispatch } = questionFixture()
      const answered = d.answerQuestion(answer)
      const closed = d.createQuestion({
        runId: identity.runId,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Close me'
      })
      d.completeDispatch(dispatch.id)
      const before = messageIds(d)
      expect(d.answerQuestion(answer)).toEqual({ ...answered, duplicate: true })
      expect(() => d.answerQuestion({ ...answer, body: 'new' })).toThrowError(
        expect.objectContaining({ code: 'answer_conflict' })
      )
      expect(() => d.answerQuestion({ ...answer, messageId: closed.message.id })).toThrowError(
        expect.objectContaining({ code: 'dispatch_inactive' })
      )
      expect(messageIds(d)).toEqual(before)
    })

    it('atomically inserts one federated reply and never repeats its relay on replay or conflict', () => {
      const { d, answer, dispatch, identity } = questionFixture(true)
      const before = messageIds(d)
      expect(() =>
        d.answerQuestion({
          ...answer,
          expectedIdentity: { ...answer.expectedIdentity, taskId: 'wrong' }
        })
      ).toThrowError(expect.objectContaining({ code: 'request_mismatch' }))
      expect(d.listPendingFederationRelay(dispatch.id, 'to_worker')).toEqual([])
      expect(messageIds(d)).toEqual(before)
      const answered = d.answerQuestion(answer)
      expect(d.answerQuestion(answer)).toEqual({ ...answered, duplicate: true })
      expect(() => d.answerQuestion({ ...answer, body: 'new' })).toThrowError(
        expect.objectContaining({ code: 'answer_conflict' })
      )
      const relay = d.listPendingFederationRelay(dispatch.id, 'to_worker')
      expect(relay).toHaveLength(1)
      expect(relay[0]).toMatchObject({
        kind: 'reply',
        payload: JSON.stringify({
          questionId: identity.messageId,
          answerMessageId: answered.message.id,
          body: answer.body
        })
      })
      expect(messageIds(d)).toEqual([...before, { id: answered.message.id }])
    })

    it('rolls back the answer and message when the federated relay exceeds quota', () => {
      const { d, answer, dispatch, identity } = questionFixture(true)
      const before = messageIds(d)
      expect(() => d.answerQuestion({ ...answer, body: 'x'.repeat(64 * 1024) })).toThrowError(
        expect.objectContaining({ code: 'relay_quota_exceeded' })
      )
      expect(d.getQuestion(identity.messageId)).toMatchObject({
        status: 'pending',
        answer_message_id: null,
        answer_body: null
      })
      expect(messageIds(d)).toEqual(before)
      expect(d.listPendingFederationRelay(dispatch.id, 'to_worker')).toEqual([])
      expect(d.answerQuestion(answer).duplicate).toBe(false)
      expect(d.listPendingFederationRelay(dispatch.id, 'to_worker')).toHaveLength(1)
    })

    it.each([false, true])(
      'rolls back receipt writes when its callback throws (duplicate=%s)',
      (duplicate) => {
        const { d, answer, dispatch, identity } = questionFixture(true)
        const original = duplicate ? d.answerQuestion(answer) : undefined
        const receipt = {
          callerFingerprint: 'caller_question',
          requestId: 'answer_receipt',
          method: 'orchestration.reply',
          payloadHash: 'exact_answer'
        }
        d.beginMutationReceipt(receipt)
        const before = messageIds(d)
        const relayBefore = d.listPendingFederationRelay(dispatch.id, 'to_worker')
        expect(() =>
          d.answerQuestion({
            ...answer,
            recordReceipt: (result) => {
              expect(result.duplicate).toBe(duplicate)
              expect(result.question.answered_at).toMatch(/Z$/)
              d.completeMutationReceipt({ ...receipt, receipt: JSON.stringify(result) })
              throw new Error('receipt write rejected')
            }
          })
        ).toThrow('receipt write rejected')
        expect(d.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)).toMatchObject({
          state: 'pending',
          receipt: null
        })
        expect(messageIds(d)).toEqual(before)
        expect(d.listPendingFederationRelay(dispatch.id, 'to_worker')).toEqual(relayBefore)
        expect(d.getQuestion(identity.messageId)?.status).toBe(duplicate ? 'answered' : 'pending')
        const accepted = d.answerQuestion({
          ...answer,
          recordReceipt: (result) => {
            d.completeMutationReceipt({ ...receipt, receipt: JSON.stringify(result) })
          }
        })
        expect(d.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)).toMatchObject({
          state: 'completed',
          receipt: JSON.stringify(accepted)
        })
        if (original) {
          expect(accepted.message).toEqual(original.message)
        }
        expect(d.listPendingFederationRelay(dispatch.id, 'to_worker')).toHaveLength(1)
      }
    )

    it('fences a competing connection after it inspected a pending question', () => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-exact-question-'))
      directories.push(directory)
      const path = join(directory, 'orchestration.db')
      const { d, identity, answer, dispatch } = questionFixture(true, path)
      const peer = new OrchestrationDb(path)
      try {
        expect(peer.inspectQuestion(identity).status).toBe('pending')
        const winner = d.answerQuestion(answer)
        expect(() => peer.answerQuestion({ ...answer, body: 'competing answer' })).toThrowError(
          expect.objectContaining({ code: 'answer_conflict' })
        )
        expect(peer.answerQuestion(answer)).toEqual({ ...winner, duplicate: true })
        expect(peer.inspectQuestion(identity).answer_message_id).toBe(winner.message.id)
        expect(messageIds(peer)).toEqual(messageIds(d))
        expect(messageIds(peer)).toHaveLength(2)
        expect(peer.listPendingFederationRelay(dispatch.id, 'to_worker')).toHaveLength(1)
      } finally {
        peer.close()
      }
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
