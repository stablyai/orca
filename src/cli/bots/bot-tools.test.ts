import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { runRemoteBotToolSignIn } from './bot-tools'

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
    const run = runRemoteBotToolSignIn(
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
