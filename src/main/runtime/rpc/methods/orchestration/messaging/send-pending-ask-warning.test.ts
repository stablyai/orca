import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

type SendWarning = { code: string; recipient: string; message: string }
type SendResult = {
  message: { id: string; to_handle: string; type: string }
  warnings?: SendWarning[]
}

function readSendReceipt(value: unknown): SendResult {
  if (typeof value !== 'object' || value === null || !('message' in value)) {
    throw new Error('expected orchestration.send to return a message receipt')
  }
  const messageValue = value.message
  if (
    typeof messageValue !== 'object' ||
    messageValue === null ||
    !('id' in messageValue) ||
    typeof messageValue.id !== 'string' ||
    !('to_handle' in messageValue) ||
    typeof messageValue.to_handle !== 'string' ||
    !('type' in messageValue) ||
    typeof messageValue.type !== 'string'
  ) {
    throw new Error('expected orchestration.send receipt message fields')
  }
  const warnings = 'warnings' in value ? readSendWarnings(value.warnings) : undefined
  return {
    message: {
      id: messageValue.id,
      to_handle: messageValue.to_handle,
      type: messageValue.type
    },
    warnings
  }
}

function readSendWarnings(value: unknown): SendWarning[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('expected orchestration.send warnings to be an array')
  }
  return value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('code' in entry) ||
      typeof entry.code !== 'string' ||
      !('recipient' in entry) ||
      typeof entry.recipient !== 'string' ||
      !('message' in entry) ||
      typeof entry.message !== 'string'
    ) {
      throw new Error('expected orchestration.send warning fields')
    }
    return { code: entry.code, recipient: entry.recipient, message: entry.message }
  })
}

describe('orchestration.send to a Dispatch blocked on ask', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let activeRunId: string | undefined

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, ctx, activeRunId } = h.setup())
  }

  function createDispatch(handle = 'term_worker') {
    return createRootDispatch(db, db.createTask({ spec: 'ask work' }).id, handle)
  }

  async function sendStatus(dispatchId: string): Promise<SendResult> {
    return readSendReceipt(
      await h.call(
        'orchestration.send',
        {
          from: 'term_coord',
          to: `dispatch:${dispatchId}`,
          type: 'status',
          subject: 'Resposta',
          body: 'This looks like an answer'
        },
        ctx
      )
    )
  }

  it('warns that status mail does not answer the pending question', async () => {
    setup()
    const dispatch = createDispatch()
    const created = db.createQuestion({
      runId: activeRunId!,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker',
      question: 'Proceed?'
    })

    const result = await sendStatus(dispatch.id)

    expect(result.message).toMatchObject({
      to_handle: `dispatch:${dispatch.id}`,
      type: 'status'
    })
    expect(result.warnings).toEqual([
      {
        code: 'pending_ask',
        recipient: `dispatch:${dispatch.id}`,
        message: `Dispatch ${dispatch.id} is blocked on question ${created.message.id}; this message does not answer it. Use orchestration reply --id ${created.message.id}.`
      }
    ])
    expect(db.getQuestion(created.message.id)).toMatchObject({
      status: 'pending',
      answer_body: null,
      answer_message_id: null
    })
    expect(db.getMessageById(result.message.id)).toMatchObject({
      to_handle: `dispatch:${dispatch.id}`,
      type: 'status',
      body: 'This looks like an answer'
    })
  })

  it('does not warn when the Dispatch has no pending question', async () => {
    setup()
    const dispatch = createDispatch()

    const result = await sendStatus(dispatch.id)

    expect(result.message.to_handle).toBe(`dispatch:${dispatch.id}`)
    expect(result.warnings?.map((warning) => warning.code) ?? []).not.toContain('pending_ask')
    expect(db.getMessageById(result.message.id)?.type).toBe('status')
  })

  it('does not warn after reply has already answered the question', async () => {
    setup()
    const dispatch = createDispatch()
    const created = db.createQuestion({
      runId: activeRunId!,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker',
      question: 'Proceed?'
    })
    db.answerQuestion({
      messageId: created.message.id,
      runId: activeRunId!,
      consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
      body: 'Yes'
    })

    const result = await sendStatus(dispatch.id)

    expect(result.warnings?.map((warning) => warning.code) ?? []).not.toContain('pending_ask')
    expect(db.getQuestion(created.message.id)?.status).toBe('answered')
  })
})
