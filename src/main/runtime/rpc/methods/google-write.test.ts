import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { getHostOperationOwnership } from '../../../../shared/execution-host/host-operation-ownership'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { GOOGLE_WRITE_METHODS } from './google-write'

const drafted = vi.hoisted((): unknown[] => [])
vi.mock('../../../google/google-api-client', () => ({
  googleApi: (account: string | undefined) => ({ email: account ?? 'ada@acme.dev' })
}))
vi.mock('../../../google/google-gmail-write', () => ({
  saveGmailDraft: async (_api: unknown, params: unknown) => {
    drafted.push(params)
    return { ref: 'gmail:draft:r-1' }
  },
  sendGmailDraft: async () => ({}),
  modifyGmail: async () => ({})
}))
vi.mock('../../../bots/tool-relay/bot-tool-relay', () => ({
  botToolRelay: { botOf: (token: string) => /^token-(b\d)$/.exec(token)?.[1] ?? null }
}))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    bots.list().find((bot) => `chat-${bot.id}` === sessionId) ?? null
}))
vi.mock('./bot-write-turn', () => ({
  readBotWriteTurn: async (_runtime: unknown, sessionId: string | undefined) =>
    sessionId === 'chat-b2'
      ? {
          bot: { name: 'Ivy' },
          inConversation: true,
          turn: {
            askers: [
              { kind: 'person', source: 'slack', userId: 'U1', name: 'Carol', role: 'member' }
            ]
          }
        }
      : null
}))

function dispatcher(bots: Bot[]) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { enabled: () => true, list: () => bots },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: google writes use only runtime.bots, runtime.lookAround and the runtime id, which the stub provides; the turn read is mocked.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [...GOOGLE_WRITE_METHODS] })
}

const draft = (params: unknown) => ({
  id: 'r1',
  authToken: 'tok',
  method: 'google.gmail.draft',
  params
})

describe('Google writes over RPC', () => {
  it('are owned by the execution host', () => {
    for (const method of GOOGLE_WRITE_METHODS) {
      expect(getHostOperationOwnership(method.name)).toBe('host')
    }
  })

  it('refuse a bot whose Google is off, and end a draft for someone else with who asked', async () => {
    const off = makeTestBot({ id: 'b1', name: 'Scout' })
    const on = makeTestBot({ id: 'b2', name: 'Ivy', google: true })
    const rpc = dispatcher([off, on])
    const refused = await rpc.dispatch(
      draft({
        botToken: 'token-b1',
        callerSessionId: 'chat-b1',
        to: ['sam@x.com'],
        subject: 'Hi',
        body: 'Hello'
      })
    )
    expect(JSON.stringify(refused)).toContain('Google is off for Scout')
    expect(drafted).toHaveLength(0)

    await expect(
      rpc.dispatch(
        draft({
          botToken: 'token-b2',
          callerSessionId: 'chat-b2',
          to: ['sam@x.com'],
          subject: 'Hi',
          body: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      rpc.dispatch(draft({ to: ['sam@x.com'], subject: 'Hi', body: 'From the owner' }))
    ).resolves.toMatchObject({ ok: true })
    expect(drafted).toEqual([
      expect.objectContaining({ body: 'Hello\n\nasked by Carol via Ivy' }),
      expect.objectContaining({ body: 'From the owner' })
    ])
  })
})
