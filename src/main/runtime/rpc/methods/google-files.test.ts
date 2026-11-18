import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { getHostOperationOwnership } from '../../../../shared/execution-host/host-operation-ownership'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { GOOGLE_FILES_METHODS } from './google-files'

const replaced = vi.hoisted((): unknown[] => [])
const written = vi.hoisted((): unknown[] => [])
vi.mock('../../../google/google-api-client', () => ({
  googleApi: (account: string | undefined) => ({ email: account ?? 'ada@acme.dev' })
}))
vi.mock('../../../google/google-docs', () => ({
  readDoc: async () => ({}),
  createDoc: async () => ({}),
  appendDoc: async () => ({}),
  commentOnDoc: async (_api: unknown, params: unknown) => {
    written.push(params)
    return { done: 'ok' }
  },
  replaceInDoc: async (api: unknown, params: unknown) => {
    replaced.push({ api, params })
    return { done: 'ok' }
  }
}))
vi.mock('../../../google/google-drive', () => ({
  searchDrive: async () => ({}),
  uploadDrive: async () => ({}),
  makeFolder: async () => ({}),
  moveDrive: async () => ({}),
  shareDrive: async (_api: unknown, params: unknown) => {
    written.push(params)
    return { done: 'ok' }
  }
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Google file methods use only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime: service, methods: [...GOOGLE_FILES_METHODS] })
}

const replace = (params: { callerSessionId?: string; account?: string; suggest?: boolean }) => ({
  id: 'r1',
  authToken: 'tok',
  method: 'google.docs.replace',
  params: {
    ref: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    pairs: [{ old: 'teh', new: 'the' }],
    ...params
  }
})

describe('Google Drive, Docs and Sheets over RPC', () => {
  it('are owned by the execution host', () => {
    for (const method of GOOGLE_FILES_METHODS) {
      expect(getHostOperationOwnership(method.name)).toBe('host')
    }
  })

  it('refuse a bot whose Google is off, and serve one whose Google is on and the owner', async () => {
    const rpc = dispatcher([
      makeTestBot({ id: 'b1', name: 'Scout' }),
      makeTestBot({ id: 'b2', name: 'Ivy', google: true })
    ])
    const refused = await rpc.dispatch(replace({ callerSessionId: 'chat-b1' }))
    expect(JSON.stringify(refused)).toContain('Google is off for Scout')
    await expect(
      rpc.dispatch(replace({ callerSessionId: 'chat-b2', suggest: true }))
    ).resolves.toMatchObject({
      ok: true
    })
    await expect(rpc.dispatch(replace({ account: 'Ada@Acme.dev' }))).resolves.toMatchObject({
      ok: true
    })
    expect(replaced).toHaveLength(2)
    expect(replaced[0]).toMatchObject({ params: { suggest: true } })
    expect(replaced[1]).toMatchObject({ api: { email: 'ada@acme.dev' } })
  })

  it('check a range is cells only, so a tab never rides in it', async () => {
    const rpc = dispatcher([])
    const answer = await rpc.dispatch({
      id: 'r2',
      authToken: 'tok',
      method: 'google.sheets.read',
      params: { ref: 'x'.repeat(30), range: 'Sheet1!A1:B2' }
    })
    expect(JSON.stringify(answer)).toContain('--tab')
  })

  it('say who asked when a bot writes for someone other than its owner', async () => {
    const rpc = dispatcher([makeTestBot({ id: 'b2', name: 'Ivy', google: true })])
    const call = (method: string, params: Record<string, unknown>) =>
      rpc.dispatch({ id: 'r3', authToken: 'tok', method, params })
    const doc = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
    await call('google.docs.comment', { callerSessionId: 'chat-b2', ref: doc, text: 'Typo' })
    await call('google.docs.comment', { ref: doc, text: 'From the owner' })
    await call('google.drive.share', {
      callerSessionId: 'chat-b2',
      ref: doc,
      with: ['sam@x.com'],
      role: 'reader'
    })
    expect(written).toEqual([
      expect.objectContaining({ text: 'Typo\n\nasked by Carol via Ivy' }),
      expect.objectContaining({ text: 'From the owner' }),
      expect.objectContaining({ askedBy: 'asked by Carol via Ivy' })
    ])
  })
})
