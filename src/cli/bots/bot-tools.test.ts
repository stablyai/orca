import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { BOT_TOOLS_HANDLERS, runHostBotToolSignIn } from './bot-tools'

describe('orca bot tools connect, for a paired server’s bot', () => {
  const PAGE = 'https://app.example.com/authorize?client_id=c&state=s-1'
  const RETURN = 'http://127.0.0.1:41234/orca/app-callback'
  let stderr: string
  beforeEach(() => {
    stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('prints the page, sends only the query of this sign-in’s pasted address, and waits for the host', async () => {
    let finished: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      finished = resolve
    })
    const answers: Record<string, (params?: Record<string, unknown>) => unknown> = {
      'status.get': () => ({
        machineName: 'build-box',
        capabilities: ['bots.tools.owned-sign-in.v1']
      }),
      'bots.tools.signIn.start': () => ({
        flowId: 'flow-1',
        revision: 1,
        expiresAt: 1,
        state: 'waiting',
        authorizationUrl: PAGE,
        redirectUri: RETURN
      }),
      'bots.tools.signIn.finish': () => {
        finished()
        return { flowId: 'flow-1', revision: 3, expiresAt: 1, state: 'done' }
      },
      'bots.tools.signIn.wait': async () => {
        await settled
        return { flowId: 'flow-1', revision: 3, expiresAt: 1, state: 'done' }
      }
    }
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => ({
      id: 'req',
      ok: true,
      result: await answers[method]!(params),
      _meta: { runtimeId: 'rt' }
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the command uses only `call`.
    const client = { call, isRemote: true } as unknown as RuntimeClient
    const input = new PassThrough()
    const run = runHostBotToolSignIn(
      { client, cwd: process.cwd(), flags: new Map(), json: false },
      { botId: 'bot-1' },
      'notion',
      () => () => {},
      input
    )
    await vi.waitFor(() => expect(stderr).toContain(PAGE))
    input.write(`${RETURN}?code=c-1&state=someone-else\n`)
    await vi.waitFor(() => expect(stderr).toContain('isn’t from this sign-in'))
    input.write(`${RETURN}?code=c-1&state=s-1\n`)
    await run
    expect(call.mock.calls.filter(([method]) => method === 'bots.tools.signIn.finish')).toEqual([
      ['bots.tools.signIn.finish', { flowId: 'flow-1', query: 'code=c-1&state=s-1' }]
    ])
    expect(call.mock.calls.some(([method]) => method === 'bots.tools.signIn.cancel')).toBe(false)
  })
})

describe('orca bot tools connect, for this computer’s bot', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  function localClient(answers: Record<string, () => unknown>) {
    const call = vi.fn(async (method: string, _params?: Record<string, unknown>) => ({
      id: 'req',
      ok: true,
      result: await answers[method]!(),
      _meta: { runtimeId: 'rt' }
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the command uses only `call`.
    return { call, client: { call, isRemote: false } as unknown as RuntimeClient }
  }
  const listed = () => ({
    agent: 'claude',
    own: [
      {
        name: 'notion',
        detail: 'https://mcp.example.com',
        remote: false,
        signIn: { state: 'signed-out' }
      }
    ],
    inherited: []
  })

  it('has the host listen for an app Orca signs in to, instead of needing a desktop browser', async () => {
    const { call, client } = localClient({
      'bots.tools.list': listed,
      'status.get': () => ({ machineName: 'box', capabilities: ['bots.tools.owned-sign-in.v1'] }),
      'bots.tools.signIn.start': () => ({
        flowId: 'flow-1',
        revision: 1,
        expiresAt: 1,
        state: 'done'
      })
    })
    await BOT_TOOLS_HANDLERS['bot tools connect']!({
      client,
      cwd: process.cwd(),
      flags: new Map([['name', 'notion']]),
      json: false
    })
    expect(call.mock.calls.find(([method]) => method === 'bots.tools.signIn.start')?.[1]).toEqual(
      expect.objectContaining({ name: 'notion', mode: 'routed' })
    )
    expect(call.mock.calls.some(([method]) => method === 'bots.tools.connect')).toBe(false)
  })

  it('sends --finish for an app Orca signs in to back to connect, not to the outdated-client path', async () => {
    const { call, client } = localClient({ 'bots.tools.list': listed })
    await expect(
      BOT_TOOLS_HANDLERS['bot tools connect']!({
        client,
        cwd: process.cwd(),
        flags: new Map([
          ['name', 'notion'],
          ['finish', 'http://127.0.0.1:41234/callback?code=c&state=s']
        ]),
        json: false
      })
    ).rejects.toThrow('Run `orca bot tools connect notion` and paste the address when it asks.')
    expect(call.mock.calls.some(([method]) => method === 'bots.tools.finishSignIn')).toBe(false)
  })
})
