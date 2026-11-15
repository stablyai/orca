import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { BOT_HANDLERS } from './bot'
import { BOT_LOOK_AROUND_HANDLERS } from './bot-look-around'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca bot new-chat', () => {
  it('from a bot’s chat, names that chat so the host can tell whose it is', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'home-1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async () => ({
      id: 'r',
      ok: true as const,
      result: { sessionId: 'home-2' },
      _meta: { runtimeId: 'rt' }
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
    const client = { call } as unknown as RuntimeClient

    await BOT_HANDLERS['bot new-chat']!({
      flags: new Map(),
      client,
      cwd: '/',
      json: false
    })

    expect(call.mock.calls).toEqual([['bots.chat.reset', { callerSessionId: 'home-1' }]])
  })
})

describe('orca bot look-around set', () => {
  function client(oldHost: boolean) {
    const calls: { method: string; params: unknown }[] = []
    const call = vi.fn(async (method: string, params?: unknown) => {
      if (oldHost && method === 'bots.lookAround.get') {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      }
      calls.push({ method, params })
      return { id: 'r', ok: true as const, result: { change: 'ok' }, _meta: { runtimeId: 'rt' } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
    return { calls, client: { call } as unknown as RuntimeClient }
  }
  const run = (target: RuntimeClient, flags: [string, string | boolean][]) =>
    BOT_LOOK_AROUND_HANDLERS['bot look-around set']!({
      flags: new Map(flags),
      client: target,
      cwd: '/',
      json: false
    })

  it('sends --at as times and --timezone host as the host clock, once the host can take them', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, '')
    const { calls, client: target } = client(false)
    await run(target, [
      ['at', '14:00, 09:30'],
      ['timezone', 'host']
    ])
    expect(calls).toEqual([
      { method: 'bots.lookAround.get', params: {} },
      {
        method: 'bots.lookAround.set',
        params: {
          times: ['14:00', '09:30'],
          timezone: null,
          editorTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      }
    ])
  })

  it('changes nothing on a host too old for custom times, even the parts it knows', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, '')
    const { calls, client: target } = client(true)
    await expect(
      run(target, [
        ['on', true],
        ['at', '09:30']
      ])
    ).rejects.toThrow(/Nothing was changed/)
    expect(calls).toEqual([])
  })
})
