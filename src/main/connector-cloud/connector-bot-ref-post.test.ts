import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { postConnectorBotMessage } from './connector-replies'
import type { ConnectorTransport } from './connector-machine'

function cloudAnswering(answer: unknown) {
  const asked: { path: string; body: unknown }[] = []
  const transport: ConnectorTransport = {
    call: async <TSchema extends z.ZodType>(path: string, body: unknown, schema: TSchema) => {
      asked.push({ path, body })
      return { ok: true as const, value: schema.parse(answer) }
    }
  }
  return { transport, asked }
}

describe('postConnectorBotMessage to a ref', () => {
  it("posts a run's result to a ref as the actions route's post, under the run's postId", async () => {
    const { transport, asked } = cloudAnswering({ ok: true, result: { queued: true } })
    const body = { postId: 'run-1', ref: 'slack:T1:C1', text: 'Done.' }
    await expect(
      postConnectorBotMessage(transport, 'bot-1', body, new AbortController().signal)
    ).resolves.toEqual({
      ok: true,
      value: undefined
    })
    expect(asked).toEqual([
      {
        path: '/v1/connector/actions',
        body: {
          v: 1,
          botId: 'bot-1',
          verb: 'post',
          ref: 'slack:T1:C1',
          args: { text: 'Done.', postId: 'run-1' }
        }
      }
    ])
  })

  it("fails with the cloud's refusal", async () => {
    const { transport } = cloudAnswering({
      ok: false,
      refusal: 'not_reachable',
      message: 'Not there.'
    })
    const posted = await postConnectorBotMessage(
      transport,
      'bot-1',
      { postId: 'run-1', ref: 'slack:T1:C1', text: 'Done.' },
      new AbortController().signal
    )
    expect(posted).toEqual({ ok: false, status: 409, error: 'not_reachable', retryAfterMs: null })
  })
})
