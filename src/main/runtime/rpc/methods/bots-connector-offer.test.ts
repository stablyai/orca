import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotConnectorOffer } from '../../../../shared/rpc-contract/bots-look-around-params'
import { BOT_GROUP_ROOM_CARD_REFUSAL } from '../../../bots/bot-group-session-access'
import { BOT_CONNECTOR_OFFER_METHOD } from './bots-connector-offer'

const cards = vi.hoisted((): unknown[] => [])
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    ['bot-chat', 'look', 'bot-group-member-m1'].includes(sessionId) ? bots.list()[0] : null
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (_destination: unknown, entry: unknown) => {
      cards.push(entry)
    }
  })
}))

type FakeGoogle = {
  client: { clientId: string } | null
  accounts: { status: string }[]
  headless: boolean
}
const google = vi.hoisted((): FakeGoogle => ({ client: null, accounts: [], headless: false }))
vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({ client: () => google.client, accounts: () => google.accounts })
}))

const request = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'bots.connector.offer',
  params
})

function offerRuntime(bot: Bot) {
  cards.length = 0
  google.client = null
  google.accounts = []
  google.headless = false
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    servesWithoutWindow: () => google.headless,
    getConnectorCloud: () => null,
    bots: { assertEnabled: () => {}, list: () => [bot] },
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'look' ? bot.id : null),
      botOfTidyUp: () => null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, runtime.lookAround, servesWithoutWindow, getConnectorCloud and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [BOT_CONNECTOR_OFFER_METHOD] })
}

describe('orca connector offer', () => {
  it('puts a Connect card in the chat for a connector the bot lacks', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', name: 'Scout' }))
    expect(
      await dispatcher.dispatch(request({ callerSessionId: 'bot-chat', source: 'slack' }))
    ).toMatchObject({ ok: true, result: { offered: true } })
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'status',
          connectorOffer: { botId: 'b1', source: 'slack' }
        })
      })
    ])
  })

  it('shows no card for a Linear workspace the bot is already in, from its chat or a group room', async () => {
    const linear = { workspaceId: 'w1', workspaceName: 'Acme', urlKey: 'acme' }
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', linear, linearWorkspaces: [linear] }))
    for (const callerSessionId of ['bot-chat', 'bot-group-member-m1']) {
      expect(
        await dispatcher.dispatch(request({ callerSessionId, source: 'linear', workspace: 'acme' }))
      ).toMatchObject({ ok: true, result: { offered: false } })
    }
    expect(cards).toEqual([])
  })

  it('puts the card that adds access in the chat for a connector the bot has', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', github: {} }))
    const answer = await dispatcher.dispatch(
      request({ callerSessionId: 'bot-chat', source: 'github' })
    )
    expect(answer).toMatchObject({ ok: true, result: { offered: true } })
    expect(answer).not.toHaveProperty('result.addAccess')
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          connectorOffer: { botId: 'b1', source: 'github', addAccess: true }
        })
      })
    ])
  })

  it('offers another workspace the owner names that the bot is not in', async () => {
    const linear = { workspaceId: 'w1', workspaceName: 'Acme' }
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', linear, linearWorkspaces: [linear] }))
    await dispatcher.dispatch(
      request({ callerSessionId: 'bot-chat', source: 'linear', workspace: 'Globex' })
    )
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          connectorOffer: { botId: 'b1', source: 'linear', workspace: 'Globex' }
        })
      })
    ])
  })

  it('refuses outside a bot chat, and from a read-only look', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1' }))
    for (const callerSessionId of ['elsewhere', 'look']) {
      expect(
        await dispatcher.dispatch(request({ callerSessionId, source: 'github' }))
      ).toMatchObject({ ok: false })
    }
    expect(cards).toEqual([])
  })

  it('refuses a card from a group room, whose transcript shows no card', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1' }))
    expect(
      await dispatcher.dispatch(
        request({ callerSessionId: 'bot-group-member-m1', source: 'github' })
      )
    ).toMatchObject({ ok: false, error: { message: BOT_GROUP_ROOM_CARD_REFUSAL } })
    expect(cards).toEqual([])
  })

  it('offers the Google card while Google is off, and none once it is on and signed in', async () => {
    const bot = makeTestBot({ id: 'b1', name: 'Scout' })
    const dispatcher = offerRuntime(bot)
    google.client = { clientId: 'c1' }
    google.accounts = [{ status: 'connected' }]
    expect(
      await dispatcher.dispatch(request({ callerSessionId: 'bot-chat', source: 'google' }))
    ).toMatchObject({ ok: true, result: { offered: true } })
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ connectorOffer: { botId: 'b1', source: 'google' } })
      })
    ])
    bot.google = true
    expect(
      await dispatcher.dispatch(request({ callerSessionId: 'bot-chat', source: 'google' }))
    ).toMatchObject({ ok: true, result: { offered: false } })
    expect(cards).toHaveLength(1)
  })

  it('posts no Google card on a server with no owner window', async () => {
    const dispatcher = offerRuntime(makeTestBot({ id: 'b1', name: 'Scout' }))
    google.headless = true
    google.client = { clientId: 'c1' }
    google.accounts = [{ status: 'connected' }]
    expect(
      await dispatcher.dispatch(request({ callerSessionId: 'bot-chat', source: 'google' }))
    ).toMatchObject({ ok: true, result: { offered: false } })
    expect(cards).toEqual([])
  })

  it('refuses a workspace for Google in the params schema', () => {
    const offer = { callerSessionId: 'bot-chat', source: 'google', workspace: 'Acme' }
    expect(BotConnectorOffer.safeParse(offer).success).toBe(false)
    expect(BotConnectorOffer.safeParse({ ...offer, source: 'linear' }).success).toBe(true)
  })
})
