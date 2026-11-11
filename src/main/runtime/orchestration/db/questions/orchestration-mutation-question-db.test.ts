import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createRootDispatch } from '../root-dispatch-test-fixture'

describe('OrchestrationDb mutation and question state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('question threads', () => {
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
