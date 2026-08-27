import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../../shared/orchestration-ask-timeout'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

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
    it('replies to a message', async () => {
      setup()
      const original = db.insertMessage({
        from: 'a',
        to: 'b',
        subject: 'question',
        runId: activeRunId
      })

      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'answer',
        from: 'b'
      })) as {
        message: { to_handle: string; subject: string; thread_id: string; run_id: string }
      }

      expect(result.message.to_handle).toBe('a')
      expect(result.message.subject).toBe('Re: question')
      expect(result.message.thread_id).toBe(original.id)
      expect(result.message.run_id).toBe(activeRunId)
    })

    it('throws on nonexistent message', async () => {
      setup()
      await expect(call('orchestration.reply', { id: 'msg_fake', body: 'nope' })).rejects.toThrow(
        'Message not found'
      )
    })

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

    it('persists a Run question and returns its first durable answer', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        const outbound = db.getInbox(10).find((message) => message.type === 'question')
        if (outbound) {
          db.answerQuestion({
            messageId: outbound.id,
            runId: activeRunId!,
            consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
            body: 'go ahead'
          })
        }
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'proceed?',
        options: 'yes, no',
        timeoutMs: 500
      })) as {
        answer: string
        messageId: string
        answerMessageId: string
        threadId: string
        timedOut: boolean
      }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('go ahead')
      expect(result.messageId).toMatch(/^msg_/)

      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      expect(outbound).toBeTruthy()
      expect(outbound?.to_handle).toBe(`run:${activeRunId}`)
      expect(outbound?.subject).toBe('Question')
      expect(outbound?.body).toBe('proceed?')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.question).toBe('proceed?')
      expect(payload.options).toEqual(['yes', 'no'])
      expect(db.getQuestion(outbound!.id)).toMatchObject({
        dispatch_id: dispatch.id,
        status: 'answered',
        answer_body: 'go ahead'
      })
      expect(db.getMessageById(result.answerMessageId)).toMatchObject({
        to_handle: `dispatch:${dispatch.id}`,
        read: 1
      })
      await expect(call('orchestration.check', { terminal: 'term_worker' })).resolves.toMatchObject(
        { count: 0, messages: [] }
      )
    })

    it('requires the Dispatch capability before creating a question', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      const capability = db.mintDispatchCapability({
        dispatchId: dispatch.id,
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )

      await expect(
        call('orchestration.ask', {
          from: 'term_worker',
          question: 'unauthorized',
          timeoutMs: 1
        })
      ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
      expect(db.getInbox(100).filter((message) => message.type === 'question')).toHaveLength(0)

      ctx = { runtime, orchestrationCapability: capability }
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
      const accepted = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'authorized',
        timeoutMs: 1
      })) as { messageId: string; timedOut: boolean }
      expect(accepted.messageId).toMatch(/^msg_/)
      expect(accepted.timedOut).toBe(true)
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

    it('rejects group addresses with a dedicated error (no message persisted)', async () => {
      setup()
      await expect(
        call('orchestration.ask', {
          from: 'term_worker',
          to: '@reviewers',
          question: 'ok?'
        })
      ).rejects.toThrow(/does not support group addresses/)
      expect(db.getInbox(10)).toHaveLength(0)
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
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'filter?',
        timeoutMs: 2_000
      })) as { answer: string; timedOut: boolean }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('correct answer')
    })

    it.each<[number | undefined, number]>([
      [undefined, 600_000],
      [ORCHESTRATION_ASK_MAX_TIMEOUT_MS, ORCHESTRATION_ASK_MAX_TIMEOUT_MS],
      [Number.MAX_SAFE_INTEGER, ORCHESTRATION_ASK_MAX_TIMEOUT_MS]
    ])('applies effective timeout %s at the RPC handler boundary', async (requested, expected) => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      let observedTimeoutMs: number | undefined
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async (_handle, options) => {
        observedTimeoutMs = options?.timeoutMs
        // End the wait loop so the assertion runs against the first budget slice.
        const outbound = db.getInbox(10).find((message) => message.type === 'question')
        // Why: without a reply the handler's while(true) spins on this mock until vitest times out, hanging instead of failing.
        expect(outbound).toBeDefined()
        db.answerQuestion({
          messageId: outbound!.id,
          runId: activeRunId!,
          consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
          body: 'ok'
        })
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'bounded?',
        timeoutMs: requested
      })) as { timeoutMs: number }

      expect(observedTimeoutMs).toBeLessThanOrEqual(expected)
      expect(observedTimeoutMs).toBeGreaterThan(expected - 1_000)
      expect(result.timeoutMs).toBe(expected)
    })

    it('returns a zero effective timeout without entering the waiter', async () => {
      setup()
      createAskingDispatch()
      const waitForMessage = vi.spyOn(runtime, 'waitForMessage')

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'negative?',
        timeoutMs: -5
      })) as { timedOut: boolean; timeoutMs: number }

      expect(waitForMessage).not.toHaveBeenCalled()
      expect(result).toMatchObject({ timedOut: true, timeoutMs: 0 })
    })

    it('parses options CSV with whitespace and empty entries', async () => {
      setup()
      createAskingDispatch('w')
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

      await call('orchestration.ask', {
        from: 'w',
        question: 'q',
        options: 'a, b ,,c',
        timeoutMs: 1
      })

      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.options).toEqual(['a', 'b', 'c'])
    })
  })
})
