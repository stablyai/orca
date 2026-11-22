import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { GOOGLE_METHODS } from './google'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'
import { BotUpdate } from '../../../../shared/rpc-contract/bots-params'

const connect = vi.hoisted(() => ({
  disconnect: vi.fn(async (email: string) => ({ removed: email, revoked: null })),
  importClient: vi.fn(() => ({ clientId: 'c', source: 'imported', savedAt: 1 })),
  exportClient: vi.fn(() => '{}'),
  startSignIn: vi.fn(() => ({ flowId: 'f1', revision: 1, phase: 'starting' })),
  accounts: vi.fn(() => [{ email: 'ada@acme.dev' }]),
  client: vi.fn(() => null),
  clientCheck: vi.fn((): 'works' | 'gone' | null => null),
  checkClient: vi.fn(async () => 'gone' as const),
  checkAccounts: vi.fn(async () => [{ email: 'ada@acme.dev' }])
}))
vi.mock('../../../google/google-connect', () => ({ getGoogleConnect: () => connect }))
vi.mock('../../../bots/tool-relay/bot-tool-relay', () => ({
  botToolRelay: { botOf: (token: string) => (token === 'scout-token' ? 'b1' : null) }
}))

const request = (method: string, params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

function googleRuntime(bots: Bot[]) {
  const updates: unknown[] = []
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: {
      enabled: () => true,
      assertEnabled: () => {},
      list: () => bots,
      update: async (botId: string, patch: Partial<Bot>) => {
        updates.push({ botId, patch })
        const bot = bots.find((entry) => entry.id === botId)
        if (!bot) {
          throw new Error('bot_not_found')
        }
        Object.assign(bot, patch)
        return bot
      }
    },
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'look' ? 'b1' : null),
      botOfTidyUp: () => null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: google.* reads only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return {
    dispatcher: new RpcDispatcher({ runtime: service, methods: [...GOOGLE_METHODS] }),
    updates
  }
}

const OWNER = { caller: DESKTOP_RPC_CALLER }

describe('google.* owner-only changes', () => {
  it.each([
    ['google.disconnect', {}],
    ['google.client.import', { file: '{}' }],
    ['google.client.export', {}],
    ['google.signIn.start', {}],
    ['google.bot.set', { botId: 'b1', on: true }]
  ])('%s is refused from a bot’s token, even an ended one', async (method, params) => {
    const { dispatcher, updates } = googleRuntime([makeTestBot({ id: 'b1', name: 'Scout' })])
    for (const botToken of ['scout-token', 'deleted-bot-token']) {
      const response = await dispatcher.dispatch(request(method, { ...params, botToken }), OWNER)
      expect(response).toMatchObject({ ok: false })
      expect(JSON.stringify(response)).toContain('Only your owner can change Google')
    }
    expect(updates).toEqual([])
    expect(connect.disconnect).not.toHaveBeenCalled()
  })

  it.each([
    ['google.disconnect', {}],
    ['google.client.import', { file: '{}' }],
    ['google.client.export', {}],
    ['google.signIn.start', {}],
    ['google.bot.set', { botId: 'b1', on: true }]
  ])('%s works from the owner’s terminal, which holds no bot token', async (method, params) => {
    const { dispatcher } = googleRuntime([makeTestBot({ id: 'b1', name: 'Scout' })])
    expect(
      await dispatcher.dispatch(request(method, { ...params, callerSessionId: 'owner-terminal' }), {
        caller: LOCAL_CLI_RPC_CALLER
      })
    ).toMatchObject({ ok: true })
  })

  it('lets the owner turn a bot’s Google on and off, and status lists only bots that have it on', async () => {
    const bots = [
      makeTestBot({ id: 'b1', name: 'Scout' }),
      makeTestBot({
        id: 'b2',
        name: 'Ivy',
        members: [{ id: 'U2', name: 'Nora', source: 'slack' }]
      })
    ]
    const { dispatcher } = googleRuntime(bots)
    expect(await dispatcher.dispatch(request('google.status', {}))).toMatchObject({
      ok: true,
      result: { bots: [] }
    })
    expect(
      await dispatcher.dispatch(
        request('google.bot.set', { botId: 'b1', on: true, callerSessionId: 'owner-terminal' }),
        OWNER
      )
    ).toMatchObject({ ok: true, result: { bot: { name: 'Scout', google: true } } })
    expect(
      await dispatcher.dispatch(request('google.bot.set', { botId: 'b2', on: true }), OWNER)
    ).toMatchObject({
      ok: true,
      result: {
        warning: 'Nora will be able to have Ivy read and send your email, calendar and files.'
      }
    })
    expect(await dispatcher.dispatch(request('google.status', {}))).toMatchObject({
      ok: true,
      result: {
        bots: [
          { id: 'b1', name: 'Scout' },
          { id: 'b2', name: 'Ivy' }
        ]
      }
    })
    await dispatcher.dispatch(request('google.bot.set', { botId: 'b1', on: false }), OWNER)
    expect(bots[0]?.google).toBe(false)
  })

  it('takes the Google toggle only through google.bot.set, never bots.update', () => {
    expect(BotUpdate.safeParse({ botId: 'b1', updates: { google: true } }).success).toBe(false)
  })

  it('disconnects the only account without --account, from the owner’s Orca', async () => {
    const { dispatcher } = googleRuntime([])
    expect(await dispatcher.dispatch(request('google.disconnect', {}), OWNER)).toMatchObject({
      ok: true,
      result: { removed: 'ada@acme.dev' }
    })
  })
})

describe('google.status and the app key', () => {
  it('reports a key Google no longer knows only from a check, then remembers it', async () => {
    const { dispatcher } = googleRuntime([])
    const plain = await dispatcher.dispatch(request('google.status', {}))
    expect(plain).toMatchObject({ ok: true })
    expect(plain).not.toMatchObject({ result: { clientKey: expect.anything() } })
    expect(await dispatcher.dispatch(request('google.status', { check: true }))).toMatchObject({
      ok: true,
      result: { clientKey: 'gone' }
    })
    connect.clientCheck.mockReturnValueOnce('gone')
    expect(await dispatcher.dispatch(request('google.status', {}))).toMatchObject({
      result: { clientKey: 'gone' }
    })
  })
})
