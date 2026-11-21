import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_CREATE_OFFER_METHOD } from './bots-create-offer'

const ROOM_SESSION = 'bot-group-member-room-1'
const HOME_CHAT = 'home-chat'

const written = vi.hoisted((): { sessionId: string; entry: unknown }[] => [])
const homes = vi.hoisted(() => ({ ensure: vi.fn(async (_botId: string) => 'home-chat') }))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    ['bot-chat', 'bot-group-member-room-1', 'home-chat'].includes(sessionId) ? bots.list()[0] : null
}))
vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => homes
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (destination: { sessionId: string }, entry: unknown) => {
      written.push({ sessionId: destination.sessionId, entry })
    }
  })
}))

const request = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'bots.createOffer',
  params
})

function offerRuntime(bot: Bot) {
  written.length = 0
  homes.ensure.mockClear()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { assertEnabled: () => {}, list: () => [bot] },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [BOT_CREATE_OFFER_METHOD] })
}

const proposal = { name: 'Release Desk', purpose: 'Keeps the release notes current.' }

describe('a bot offering a new bot', () => {
  it('puts the card in the chat that asked', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', name: 'Scout' }))
    expect(
      await dispatcher.dispatch(request({ callerSessionId: 'bot-chat', ...proposal }))
    ).toMatchObject({ ok: true, result: { offered: true } })
    expect(written.map(({ sessionId }) => sessionId)).toEqual(['bot-chat'])
    expect(homes.ensure).not.toHaveBeenCalled()
  })

  it('puts an offer made in a group room in the bot’s Home chat, where the owner can press Create', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', name: 'Scout' }))
    const response = await dispatcher.dispatch(
      request({ callerSessionId: ROOM_SESSION, ...proposal })
    )
    expect(homes.ensure).toHaveBeenCalledWith('b1')
    expect(written).toEqual([
      {
        sessionId: HOME_CHAT,
        entry: expect.objectContaining({
          body: expect.objectContaining({ presentation: 'bot-create-offer' })
        })
      }
    ])
    expect(response).toMatchObject({
      ok: true,
      result: { offered: true, message: expect.stringContaining('in your Home chat') }
    })
  })
})
