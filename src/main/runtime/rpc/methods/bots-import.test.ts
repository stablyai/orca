import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_IMPORT_METHODS } from './bots-import'

const cards = vi.hoisted((): unknown[] => [])
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    sessionId === 'bot-chat' || sessionId === 'look' ? bots.list()[0] : null
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (_destination: unknown, entry: unknown) => {
      cards.push(entry)
    }
  })
}))

const request = (method: string, params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

function importRuntime(bot: Bot) {
  cards.length = 0
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { assertEnabled: () => {}, list: () => [bot] },
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'look' ? bot.id : null),
      botOfTidyUp: () => null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods read only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [...BOT_IMPORT_METHODS] })
}

const plan = {
  app: 'OpenClaw',
  name: 'Molty',
  items: [
    { group: 'comes', what: 'Who Molty is', to: 'Soul', why: 'From its persona.' },
    { group: 'stays', what: 'Telegram', why: 'Not available here yet.' }
  ]
}

describe('bot import cards', () => {
  it('puts the plan in the bot chat as a card, with the bot it belongs to', async () => {
    const dispatcher = importRuntime(makeTestBot({ id: 'b1', name: 'Molty' }))
    expect(
      await dispatcher.dispatch(request('bots.import.plan', { callerSessionId: 'bot-chat', plan }))
    ).toMatchObject({ ok: true })
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'status',
          presentation: 'bot-import-plan',
          botImportPlan: { ...plan, botId: 'b1' }
        })
      })
    ])
  })

  it('refuses outside a bot chat and from a look-around run', async () => {
    const dispatcher = importRuntime(makeTestBot({ id: 'b1' }))
    for (const callerSessionId of ['elsewhere', 'look']) {
      expect(
        await dispatcher.dispatch(request('bots.import.plan', { callerSessionId, plan }))
      ).toMatchObject({ ok: false })
    }
    expect(cards).toEqual([])
  })

  it('refuses a plan with nothing in it', async () => {
    const dispatcher = importRuntime(makeTestBot({ id: 'b1' }))
    expect(
      await dispatcher.dispatch(
        request('bots.import.plan', { callerSessionId: 'bot-chat', plan: { ...plan, items: [] } })
      )
    ).toMatchObject({ ok: false })
  })

  it('puts the summary in the chat', async () => {
    const dispatcher = importRuntime(makeTestBot({ id: 'b1' }))
    const done = {
      app: 'Hermes',
      name: 'Research desk',
      created: [{ kind: 'automations', what: '2 automations', detail: 'paused' }],
      stayed: ['chat history'],
      paused: 2
    }
    await dispatcher.dispatch(request('bots.import.done', { callerSessionId: 'bot-chat', done }))
    expect(cards).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ botImportDone: { ...done, botId: 'b1' } })
      })
    ])
  })
})
