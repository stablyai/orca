import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from '../runtime/client'
import { BOT_HANDLERS } from './bot'

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
