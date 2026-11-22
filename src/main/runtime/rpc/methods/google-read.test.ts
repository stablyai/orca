import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { botToolRelay } from '../../../bots/tool-relay/bot-tool-relay'
import { GOOGLE_READ_METHODS } from './google-read'
import { BOT_SESSION_NEEDS_TOKEN } from '../bot-session-caller-guard'

const searched = vi.hoisted((): unknown[] => [])
vi.mock('../../../google/google-api-client', () => ({
  googleApi: (account: string | undefined) => ({ email: account ?? 'ada@acme.dev' })
}))
vi.mock('../../../google/google-gmail-read', () => ({
  searchGmail: async (api: unknown, params: unknown) => {
    searched.push({ api, params })
    return { account: 'ada@acme.dev', threads: [] }
  },
  readGmail: async () => ({}),
  downloadGmailAttachment: async () => ({})
}))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    bots.list().find((bot) => `chat-${bot.id}` === sessionId) ?? null
}))

function dispatcher(bots: Bot[]) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { enabled: () => true, list: () => bots },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: google reads use only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [...GOOGLE_READ_METHODS] })
}

const request = (params: unknown) => ({
  id: 'r1',
  authToken: 'tok',
  method: 'google.gmail.search',
  params
})

describe('Google reads over RPC', () => {
  afterAll(() => botToolRelay.close())

  it('refuse a bot whose Google is off by its token, and serve one whose Google is on and the owner', async () => {
    const off = makeTestBot({ id: 'b1', name: 'Scout' })
    const on = makeTestBot({ id: 'b2', name: 'Ivy', google: true })
    const rpc = dispatcher([off, on])
    const offToken = (await botToolRelay.grant('b1', '/bots/scout')).token
    const onToken = (await botToolRelay.grant('b2', '/bots/ivy')).token
    const refused = await rpc.dispatch(request({ botToken: offToken, query: 'x' }))
    expect(JSON.stringify(refused)).toContain('Google is off for Scout')
    await expect(rpc.dispatch(request({ botToken: onToken, query: 'x' }))).resolves.toMatchObject({
      ok: true
    })
    // The owner's terminal holds no bot token.
    await expect(
      rpc.dispatch(request({ query: 'from:sam', account: 'Ada@Acme.dev' }))
    ).resolves.toMatchObject({ ok: true })
    expect(searched).toHaveLength(2)
    expect(searched[1]).toMatchObject({ api: { email: 'ada@acme.dev' } })
  })

  it('name the bot by its token, and refuse a run that names another bot’s chat', async () => {
    searched.length = 0
    const rpc = dispatcher([
      makeTestBot({ id: 'b1', name: 'Scout' }),
      makeTestBot({ id: 'b2', name: 'Ivy', google: true })
    ])
    const { token } = await botToolRelay.grant('b1', '/bots/scout')
    for (const callerSessionId of ['owner-terminal', undefined]) {
      const response = await rpc.dispatch(request({ botToken: token, callerSessionId, query: 'x' }))
      expect(JSON.stringify(response)).toContain('Google is off for Scout')
    }
    const posing = await rpc.dispatch(
      request({ botToken: token, callerSessionId: 'chat-b2', query: 'x' })
    )
    expect(posing).toMatchObject({ ok: false, error: { message: BOT_SESSION_NEEDS_TOKEN } })
    expect(searched).toEqual([])
  })

  it('refuse a deleted bot’s token rather than take it for the owner', async () => {
    searched.length = 0
    const rpc = dispatcher([makeTestBot({ id: 'b2', name: 'Ivy', google: true })])
    const { token } = await botToolRelay.grant('b2', '/bots/ivy')
    botToolRelay.revoke('b2')
    const response = await rpc.dispatch(request({ botToken: token, query: 'x' }))
    expect(JSON.stringify(response)).toContain('Orca token has ended')
    expect(searched).toEqual([])
  })
})
