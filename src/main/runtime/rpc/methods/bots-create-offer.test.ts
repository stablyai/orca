import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_GROUP_ROOM_CARD_REFUSAL } from '../../../bots/bot-group-session-access'
import { BOT_CREATE_OFFER_METHOD } from './bots-create-offer'

const cards = vi.hoisted((): unknown[] => [])
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }) => bots.list()[0]
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (_destination: unknown, entry: unknown) => {
      cards.push(entry)
    }
  })
}))

function offerDispatcher(bots: Bot[] = [makeTestBot({ id: 'b1', name: 'Scout' })]) {
  cards.length = 0
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { assertEnabled: () => {}, list: () => bots },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [BOT_CREATE_OFFER_METHOD] })
}

const offer = (callerSessionId: string, name = 'Triage') => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'bots.createOffer',
  params: { callerSessionId, name, purpose: 'Triages new issues.' }
})

describe('orca bot create --offer', () => {
  it('refuses from a group room, whose transcript shows no card', async () => {
    const dispatcher = offerDispatcher()
    expect(await dispatcher.dispatch(offer('bot-group-member-m1'))).toMatchObject({
      ok: false,
      error: { message: BOT_GROUP_ROOM_CARD_REFUSAL }
    })
    expect(cards).toEqual([])
    expect(await dispatcher.dispatch(offer('bot-chat'))).toMatchObject({
      ok: true,
      result: { offered: true }
    })
    expect(cards).toHaveLength(1)
  })

  it('tells a group room a name is taken, with no card, before refusing the card', async () => {
    const dispatcher = offerDispatcher()
    expect(await dispatcher.dispatch(offer('bot-group-member-m1', 'scout'))).toMatchObject({
      ok: true,
      result: { offered: false }
    })
    expect(cards).toEqual([])
  })

  it("puts the card in the owner's own chat when no bot runs there", async () => {
    const dispatcher = offerDispatcher([])
    expect(await dispatcher.dispatch(offer('owner-chat'))).toMatchObject({
      ok: true,
      result: { offered: true }
    })
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          text: expect.stringMatching(/^This chat suggests a new bot, Triage:/),
          botCreateOffer: expect.not.objectContaining({ botId: expect.anything() })
        })
      })
    ])
  })
})
