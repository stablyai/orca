import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import { BOT_GOOGLE_SETUP_HANDLERS, formatGoogleSetupRun } from './bot-google-setup'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const done = { status: 'done' as const, at: 2, by: 'bot' as const }
const run = (steps: GoogleSetupRun['steps']): GoogleSetupRun => ({
  id: 'run-1',
  botId: 'ivy',
  state: 'running',
  mode: 'do-it-for-me',
  steps,
  answers: {},
  startedAt: 1,
  updatedAt: 1,
  revision: 1
})

describe('orca bot google-setup show', () => {
  it('names the sign-in the owner owes while only connect is left', () => {
    const shown = formatGoogleSetupRun({
      run: run({
        account: done,
        project: done,
        apis: done,
        branding: done,
        links: done,
        publish: done,
        client: done
      })
    })
    expect(shown).toContain('Waiting on your owner: sign in on the Connect Google card.')
    expect(shown).toContain("Your owner's card shows: Sign in to Google")
  })

  it('says the key is missing while client is open', () => {
    const shown = formatGoogleSetupRun({
      run: run({ client: { status: 'active', at: 2 } }),
      keyMissing: true
    })
    expect(shown).toContain("Key: Orca doesn't have the app's key yet.")
    expect(shown).not.toContain('Waiting on your owner')
  })
})

describe('orca bot google-setup start', () => {
  const routed = { routed: 'offer', message: 'Your owner now sees a Connect card.' }
  const start = async (json: boolean): Promise<string> => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'bot-chat')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async () => ({ id: 'r1', ok: true, result: routed }))
    await BOT_GOOGLE_SETUP_HANDLERS['bot google-setup start']({
      flags: new Map(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
      client: { call } as never,
      cwd: '/',
      json
    })
    expect(call).toHaveBeenCalledWith('bots.googleSetup.write', {
      callerSessionId: 'bot-chat',
      change: { action: 'start' }
    })
    return String(log.mock.calls[0]?.[0])
  }

  it('prints the line Orca answered a start with instead of a setup, never "no setup started"', async () => {
    expect(await start(false)).toBe('Your owner now sees a Connect card.')
  })

  it('gives the routed answer as JSON', async () => {
    expect(JSON.parse(await start(true))).toMatchObject({ result: routed })
  })
})
