import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { OrchestrationMutationExecutor } from '../../../orchestration-mutation-executor'

describe('exact question RPC', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  function setup() {
    const state = h.setup()
    const task = state.db.createTask({ spec: 'synthetic question' })
    const dispatch = createRootDispatch(state.db, task.id, 'term_worker')
    const created = state.db.createQuestion({
      runId: state.activeRunId!,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker',
      question: 'Choose the output format',
      options: ['json', 'text']
    })
    vi.spyOn(state.runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const identity = {
      id: created.question.message_id,
      run: state.activeRunId!,
      task: task.id,
      dispatch: dispatch.id
    }
    const reply = { ...identity, mode: 'question', body: 'json', from: 'term_coord' }
    return { ...state, identity, reply }
  }

  it('inspects original material and observes the accepted answer', async () => {
    const { ctx, identity, reply } = setup()
    expect(await h.call('orchestration.questionInspect', identity, ctx)).toMatchObject({
      question: {
        message_id: identity.id,
        run_id: identity.run,
        task_id: identity.task,
        dispatch_id: identity.dispatch,
        body: 'Choose the output format',
        options: ['json', 'text'],
        status: 'pending'
      }
    })
    await h.call('orchestration.questionReply', reply, ctx)
    expect(await h.call('orchestration.questionInspect', identity, ctx)).toMatchObject({
      question: { status: 'answered', answer_body: 'json' }
    })
  })

  it('refuses question fallback and ordinary-message selection on questions', async () => {
    const { db, ctx, identity, reply } = setup()
    const ordinary = db.insertMessage({ from: 'term_worker', to: 'term_coord', subject: 'note' })
    for (const id of ['msg_missing', ordinary.id]) {
      await expect(
        h.call('orchestration.questionReply', { ...reply, id }, ctx)
      ).rejects.toMatchObject({
        code: 'question_not_found'
      })
    }
    await expect(
      h.call('orchestration.messageReply', { ...reply, mode: 'message' }, ctx)
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    expect(db.getAllMessagesForHandle('term_worker', 100)).toEqual([])
    expect(db.getAllMessagesForHandle(`dispatch:${identity.dispatch}`, 100)).toEqual([])
    expect(db.getQuestion(identity.id)?.status).toBe('pending')
  })

  it('rejects wrong exact identities before notifying or answering', async () => {
    const { db, runtime, ctx, reply, identity } = setup()
    for (const changed of [{ task: 'task_wrong' }, { dispatch: 'ctx_stale' }]) {
      await expect(
        h.call('orchestration.questionReply', { ...reply, ...changed }, ctx)
      ).rejects.toMatchObject({
        code: 'request_mismatch'
      })
    }
    expect(db.getQuestion(identity.id)?.status).toBe('pending')
    expect(db.getAllMessagesForHandle(`dispatch:${identity.dispatch}`, 100)).toEqual([])
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it('serializes contenders and reconciles a lost response with the original mutation', async () => {
    const { db, runtime, ctx, reply, identity } = setup()
    const executor = new OrchestrationMutationExecutor(runtime)
    const mutate = (requestId: string, params: Record<string, unknown>) =>
      executor.run(
        {
          id: requestId,
          authToken: 'synthetic_owner',
          method: 'orchestration.questionReply',
          orchestrationRequestId: requestId
        },
        params,
        (mutation) =>
          h.call('orchestration.questionReply', params, {
            ...ctx,
            recordMutationReceipt: mutation?.recordReceipt,
            replayedMutationReceipt: mutation?.replayedReceipt
          }),
        'synthetic_owner'
      )
    const outcomes = await Promise.allSettled([
      mutate('answer_original', reply),
      mutate('answer_contender', { ...reply, body: 'text' })
    ])
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' })
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'answer_conflict' }
    })
    const original = db.getQuestion(identity.id)?.answer_message_id
    expect(await mutate('answer_original', reply)).toMatchObject({ message: { id: original } })
    await expect(mutate('answer_original', { ...reply, body: 'changed' })).rejects.toMatchObject({
      code: 'request_mismatch'
    })
    expect(
      db.getAllMessagesForHandle(`dispatch:${identity.dispatch}`, 100).map((m) => m.id)
    ).toEqual([original])
  })
})
