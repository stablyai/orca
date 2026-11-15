import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcContext } from '../../../core'

import { createOrchestrationRpcHarness } from '../rpc-test-harness'

import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

import type { OrcaRuntimeService } from '../../../../orca-runtime'

import '../../../../../../shared/orchestration/mailbox/orchestration-ask-timeout'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'

import { deliverQuestionAnswer } from '../../../../orchestration/mailbox/questions/question-answer-delivery'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey, findMethod } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('orchestration.reply', () => {
    it('records one idempotent answer from the current Run consumer', async () => {
      setup()
      const task = db.createTask({ spec: 'question work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      const created = db.createQuestion({
        runId: activeRunId!,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Proceed?'
      })
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const first = (await call('orchestration.reply', {
        id: created.message.id,
        body: 'Yes',
        from: 'term_coord'
      })) as { message: { id: string; to_handle: string }; duplicate: boolean }
      const repeated = (await call('orchestration.reply', {
        id: created.message.id,
        body: 'Yes',
        from: 'term_coord'
      })) as { message: { id: string }; duplicate: boolean }

      expect(first.message.to_handle).toBe(`dispatch:${dispatch.id}`)
      expect(first.duplicate).toBe(false)
      expect(repeated).toMatchObject({
        message: { id: first.message.id },
        duplicate: true
      })
      expect(notify).toHaveBeenCalledWith(`dispatch:${dispatch.id}`, 'status')
      expect(db.getQuestion(created.message.id)).toMatchObject({
        status: 'answered',
        answer_body: 'Yes'
      })
      await expect(
        call('orchestration.reply', {
          id: created.message.id,
          body: 'No',
          from: 'term_coord'
        })
      ).rejects.toMatchObject({ code: 'answer_conflict' })
    })
  })

  describe('orchestration.ask', () => {
    function createAskingDispatch(handle = 'term_worker') {
      const task = db.createTask({ spec: 'question work' })
      const dispatch = createRootDispatch(db, task.id, handle)
      return { task, dispatch }
    }

    it('creates a question only from the exact process that owns the Dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'question work' })
      createRootDispatch(
        db,
        task.id,
        'term_worker',
        'tab_worker:leaf_worker',
        undefined,
        'runtime_test:term_worker:1'
      )
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
      const incarnation = vi
        .spyOn(runtime, 'getTerminalProcessIncarnation')
        .mockReturnValue('runtime_test:term_worker:2')

      await expect(
        call('orchestration.ask', { from: 'term_worker', question: 'stale', timeoutMs: 1 })
      ).rejects.toMatchObject({ code: 'worker_identity_changed' })
      expect(db.getInbox(100).filter((message) => message.type === 'question')).toHaveLength(0)

      incarnation.mockReturnValue('runtime_test:term_worker:1')
      expect(
        await call('orchestration.ask', { from: 'term_worker', question: 'current', timeoutMs: 1 })
      ).toMatchObject({ messageId: expect.stringMatching(/^msg_/), timedOut: true })
    })

    it('returns timedOut when no reply arrives in the window', async () => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'still there?',
        timeoutMs: 1
      })) as { answer: string | null; timedOut: boolean; messageId: string | null }

      expect(result.timedOut).toBe(true)
      expect(result.answer).toBeNull()
      expect(result.messageId).toMatch(/^msg_/)
      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      expect(outbound).toBeTruthy()
      expect(db.getQuestion(outbound!.id)?.status).toBe('pending')
    })

    it('resumes the original question without creating a duplicate', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      const created = db.createQuestion({
        runId: activeRunId!,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Resume me'
      })
      db.answerQuestion({
        messageId: created.message.id,
        runId: activeRunId!,
        consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
        body: 'recorded answer'
      })
      const messageCount = db.getInbox(100).length

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        resume: created.message.id,
        timeoutMs: 500
      })) as { answer: string; messageId: string; timedOut: boolean }

      expect(result).toMatchObject({
        answer: 'recorded answer',
        messageId: created.message.id,
        timedOut: false
      })
      expect(db.getInbox(100)).toHaveLength(messageCount)
    })

    it('returns promptly when the RPC signal aborts while waiting', async () => {
      setup()
      createAskingDispatch()
      vi.useFakeTimers()
      const controller = new AbortController()
      const method = findMethod('orchestration.ask')
      const parsed = method.params!.parse({
        from: 'term_worker',
        question: 'still there?',
        timeoutMs: 60_000
      })

      try {
        const promise = method.handler(parsed, {
          runtime,
          signal: controller.signal
        }) as Promise<{ timedOut: boolean; cancelled: boolean }>

        controller.abort()
        const outcomePromise = Promise.race([
          promise.then((result) => (result.cancelled ? 'cancelled' : 'answered')),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
        ])
        await vi.advanceTimersByTimeAsync(0)
        const outcome = await outcomePromise

        expect(outcome).toBe('cancelled')
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores unrelated wakes until the durable question is answered', async () => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      let wakeCount = 0
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        wakeCount++
        const outbound = db.getInbox(20).find((message) => message.type === 'question')
        if (wakeCount === 1 && outbound) {
          db.insertMessage({
            from: 'unrelated',
            to: `dispatch:${db.getQuestion(outbound.id)!.dispatch_id}`,
            subject: 'unrelated',
            body: 'other',
            runId: activeRunId
          })
        } else if (wakeCount === 2 && outbound) {
          db.answerQuestion({
            messageId: outbound.id,
            runId: activeRunId!,
            consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
            body: 'correct answer'
          })
        }
        return new MessageWake()
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'filter?',
        timeoutMs: 2_000
      })) as { answer: string; timedOut: boolean }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('correct answer')
    })
  })

  describe('ask, then end the turn', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve))
    const askedQuestion = () => db.getInbox(20).find((message) => message.type === 'question')!

    function askingDispatch() {
      const task = db.createTask({ spec: 'question work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      const deliver = vi
        .spyOn(runtime, 'deliverPendingMessagesForHandle')
        .mockImplementation(() => {})
      const woke = () => deliver.mock.calls.some(([handle]) => handle === `dispatch:${dispatch.id}`)
      return { dispatch, woke }
    }

    it('lets other mail wake a worker blocked on a waiting ask', async () => {
      setup()
      const { dispatch, woke } = askingDispatch()
      const asking = call('orchestration.ask', {
        from: 'term_worker',
        question: 'Proceed?',
        timeoutMs: 5_000
      })
      await flush()

      await call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'Change of plan',
        body: 'Drop the question; do the other thing.'
      })
      await flush()
      expect(woke()).toBe(true)

      await call('orchestration.reply', { id: askedQuestion().id, body: 'yes', from: 'term_coord' })
      await expect(asking).resolves.toMatchObject({ answer: 'yes' })
    })

    it('gives a waiting ask its answer without also waking the worker with it', async () => {
      setup()
      const { woke } = askingDispatch()
      const asking = call('orchestration.ask', {
        from: 'term_worker',
        question: 'Proceed?',
        timeoutMs: 5_000
      })
      await flush()

      const question = askedQuestion()
      await call('orchestration.reply', { id: question.id, body: 'yes', from: 'term_coord' })
      await expect(asking).resolves.toMatchObject({ answer: 'yes' })
      await flush()

      expect(woke()).toBe(false)
      const answerId = db.getQuestion(question.id)!.answer_message_id!
      expect(db.getMessageById(answerId)?.read).toBe(1)
    })

    it('leaves an answer that lands as its waiting ask is cancelled to wake the worker', async () => {
      setup()
      const { dispatch, woke } = askingDispatch()
      const controller = new AbortController()
      const method = findMethod('orchestration.ask')
      const asking = method.handler(
        method.params!.parse({ from: 'term_worker', question: 'Proceed?', timeoutMs: 5_000 }),
        { runtime, signal: controller.signal }
      )
      await flush()

      const question = askedQuestion()
      controller.abort()
      const answered = db.answerQuestion({
        messageId: question.id,
        runId: activeRunId!,
        consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
        body: 'yes'
      })
      deliverQuestionAnswer(runtime, { message_id: question.id, dispatch_id: dispatch.id })

      await expect(asking).resolves.toMatchObject({ cancelled: true, answer: null })
      await flush()
      expect(db.getMessageById(answered.message.id)?.read).toBe(0)
      expect(woke()).toBe(true)
    })

    it('ends a waiting ask at once when its Dispatch is abandoned', async () => {
      setup()
      const { dispatch } = askingDispatch()
      const asking = call('orchestration.ask', {
        from: 'term_worker',
        question: 'Proceed?',
        timeoutMs: 60_000
      })
      await flush()

      db.closeQuestionsForDispatch(dispatch.id)
      runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')
      await expect(asking).rejects.toMatchObject({ code: 'dispatch_inactive' })
    })
  })
})
