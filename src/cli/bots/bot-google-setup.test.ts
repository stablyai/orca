import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { BOT_GOOGLE_SETUP_HANDLERS } from './bot-google-setup'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca bot google-setup start', () => {
  it('prints the line Orca answered a start with instead of a setup, never "no setup started"', async () => {
    const routed = { routed: 'offer', message: 'Your owner now sees a Connect card.' }
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'bot-chat')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async () => ({ id: 'r1', ok: true, result: routed }))

    await BOT_GOOGLE_SETUP_HANDLERS['bot google-setup start']({
      flags: new Map(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
      client: { call } as never,
      cwd: '/',
      json: false
    })

    expect(call).toHaveBeenCalledWith('bots.googleSetup.write', {
      callerSessionId: 'bot-chat',
      change: { action: 'start' }
    })
    expect(log.mock.calls[0]?.[0]).toBe('Your owner now sees a Connect card.')
  })
})
