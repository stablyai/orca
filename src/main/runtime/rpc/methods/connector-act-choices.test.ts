import { beforeEach, describe, expect, it, vi } from 'vitest'

const { postConnectorAction } = vi.hoisted(() => ({ postConnectorAction: vi.fn() }))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: () => ({ id: 'bot-1', name: 'Reviewer' })
}))
vi.mock('../../../bots/bot-turn-for', () => ({ botTurnFor: async () => undefined }))
vi.mock('../../../connector-cloud/connector-actions', () => ({ postConnectorAction }))

import { CONNECTOR_ACT_METHOD } from './connector-act'

function context(features: string[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reply reaches the cloud reading only these runtime fields.
  return {
    runtime: {
      bots: { enabled: () => true },
      lookAround: { botOfTidyUp: () => null, botOfLook: () => null },
      getConnectorCloud: () => ({ cloudFeatures: () => new Set(features), status: () => 'ready' }),
      getExternalConversationSeam: () => undefined
    }
  } as unknown as Parameters<typeof CONNECTOR_ACT_METHOD.handler>[1]
}

const reply = {
  sessionId: 'session-1',
  verb: 'reply' as const,
  args: { text: 'Ship it?', choices: ['Yes', 'Not yet'], postId: 'p-1' }
}

describe('connector.act reply choices', () => {
  beforeEach(() => {
    postConnectorAction.mockReset()
    postConnectorAction.mockResolvedValue({ ok: true, value: { ok: true, result: {} } })
  })

  it('refuses them, posting nothing, to a cloud that can’t put buttons on a reply', async () => {
    await expect(CONNECTOR_ACT_METHOD.handler(reply, context(['actions']))).rejects.toMatchObject({
      code: 'cloud_lacks_reply_choices'
    })
    expect(postConnectorAction).not.toHaveBeenCalled()
  })

  it('sends them to a cloud that lists reply.choices', async () => {
    await CONNECTOR_ACT_METHOD.handler(reply, context(['actions', 'reply.choices']))
    expect(postConnectorAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        verb: 'reply',
        args: expect.objectContaining({ choices: ['Yes', 'Not yet'] })
      }),
      expect.anything()
    )
  })
})
