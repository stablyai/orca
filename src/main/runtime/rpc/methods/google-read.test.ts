import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { getHostOperationOwnership } from '../../../../shared/execution-host/host-operation-ownership'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { GOOGLE_READ_METHODS } from './google-read'

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
  it('are owned by the execution host', () => {
    for (const method of GOOGLE_READ_METHODS) {
      expect(getHostOperationOwnership(method.name)).toBe('host')
    }
  })

  it('refuse a bot whose Google is off, and serve one whose Google is on and the owner', async () => {
    const off = makeTestBot({ id: 'b1', name: 'Scout' })
    const on = makeTestBot({ id: 'b2', name: 'Ivy', google: true })
    const rpc = dispatcher([off, on])
    const refused = await rpc.dispatch(request({ callerSessionId: 'chat-b1', query: 'x' }))
    expect(JSON.stringify(refused)).toContain('Google is off for Scout')
    await expect(
      rpc.dispatch(request({ callerSessionId: 'chat-b2', query: 'x' }))
    ).resolves.toMatchObject({ ok: true })
    await expect(
      rpc.dispatch(request({ query: 'from:sam', account: 'Ada@Acme.dev' }))
    ).resolves.toMatchObject({ ok: true })
    expect(searched).toHaveLength(2)
    expect(searched[1]).toMatchObject({ api: { email: 'ada@acme.dev' } })
  })
})
