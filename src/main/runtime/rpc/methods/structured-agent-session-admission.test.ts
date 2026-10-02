// The host's own structured-chat setting is its user's launch preference, not admission control:
// a paired client that can read structured sessions reaches every method whatever that setting says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  CLEANUP_METHODS,
  WORK_METHODS
} from './structured-agent-session-gate-classification.test-fixture'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

const SETTING_OFF = { getClientSettings: () => ({ experimentalStructuredNativeChat: false }) }
const SETTING_ON = { getClientSettings: () => ({ experimentalStructuredNativeChat: true }) }
// A client that picks each launch's mode itself, as the desktop does.
const MODE_CHOOSING_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
  ]
}
// Phones released before `agent.launch` picked their mode by asking createSupport.
const RELEASED_PHONE = {
  clientKind: 'mobile' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_RUNTIME_CAPABILITY
  ]
}
const CREATE_SUPPORT = WORK_METHODS.find((entry) => entry.method === 'agentSession.createSupport')!
const UNSUPPORTED = { message: expect.stringContaining('structured_agent_session_unsupported') }

describe('a host with structured chat turned off', () => {
  it.each(WORK_METHODS)('still serves $method to a capable client', async ({ method, params }) => {
    const response = await call(method, params, MODE_CHOOSING_CLIENT, SETTING_OFF).catch(
      (error: Error) => {
        // An admitted stream the stub never feeds answers nothing; a refused one replies at once.
        expect(error.message).toBe(`no reply for ${method}`)
        return null
      }
    )

    // Other failures are the stub's business; the one this pins is the gate's own refusal.
    expect(response).not.toMatchObject({ ok: false, error: UNSUPPORTED })
  })

  it.each(CLEANUP_METHODS)('still serves $method to a capable client', async (entry) => {
    const response = await call(entry.method, entry.params, MODE_CHOOSING_CLIENT, SETTING_OFF)

    expect(response).toMatchObject({ ok: true })
    // `unsubscribe` retires runtime-owned subscriptions and `release` is a no-op, so neither
    // calls the host: the result payload is the observable effect.
    if (entry.hostCall === null) {
      expect(response).toMatchObject({ result: entry.result })
    } else {
      expect(hostCalls[entry.hostCall]).toHaveBeenCalled()
    }
  })

  it('creates a session for a paired client', async () => {
    const create = WORK_METHODS.find((entry) => entry.method === 'agentSession.create')!
    const response = await call(create.method, create.params, MODE_CHOOSING_CLIENT, SETTING_OFF)

    expect(response).toMatchObject({ ok: true })
  })

  it('stops the provider child and retires the tab when a chat is closed', async () => {
    const response = await call(
      'agentSession.close',
      { sessionId: SESSION },
      STRUCTURED_CLIENT,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION, 'user-close')
    // The durable tab has to be retired too, or the chat comes back on the next sync.
    expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false)
  })

  it('cancels an in-flight turn', async () => {
    const response = await call(
      'agentSession.cancel',
      { envelope: envelope(), turnId: 'turn-1' },
      STRUCTURED_CLIENT,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.cancel).toHaveBeenCalledOnce()
  })

  it.each([...WORK_METHODS, ...CLEANUP_METHODS])(
    'refuses $method to a client that never advertised the capability',
    async ({ method, params }) => {
      const response = await call(
        method,
        params,
        { clientKind: 'runtime', clientCapabilities: [] },
        SETTING_ON
      )

      // Asserting the gate's own code, not merely `ok: false`: a params-validation failure would
      // pass a bare falsy check and hide a gate that had stopped refusing.
      expect(response).toMatchObject({ ok: false, error: UNSUPPORTED })
    }
  )

  it.each(['runtime', 'mobile'] as const)(
    'lets a %s client close a chat it already owns',
    async (clientKind) => {
      const response = await call(
        'agentSession.close',
        { sessionId: SESSION },
        { clientKind, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] },
        SETTING_OFF
      )

      expect(response).toMatchObject({ ok: true })
      expect(hostCalls.close).toHaveBeenCalledWith(SESSION, 'user-close')
    }
  )
})

describe('a client that leaves the launch mode to the host', () => {
  it('is told a chat is unsupported while the host setting is off, so it opens a terminal', async () => {
    const response = await call(
      CREATE_SUPPORT.method,
      CREATE_SUPPORT.params,
      RELEASED_PHONE,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: false, error: UNSUPPORTED })
    expect(runtimeCalls.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('is answered by the workspace once the host setting is on', async () => {
    const response = await call(
      CREATE_SUPPORT.method,
      CREATE_SUPPORT.params,
      RELEASED_PHONE,
      SETTING_ON
    )

    expect(response).toMatchObject({ ok: true })
  })

  it('reads an unreadable settings store as off', async () => {
    const response = await call(CREATE_SUPPORT.method, CREATE_SUPPORT.params, RELEASED_PHONE, {
      getClientSettings: () => {
        throw new Error('store unavailable')
      }
    })

    expect(response).toMatchObject({ ok: false, error: UNSUPPORTED })
  })

  it('keeps every other method on capability alone', async () => {
    const create = WORK_METHODS.find((entry) => entry.method === 'agentSession.create')!
    const response = await call(create.method, create.params, RELEASED_PHONE, SETTING_OFF)

    expect(response).toMatchObject({ ok: true })
  })
})

// A paired client's picker shows the saved selection create will start the chat with.
describe("createSupport's launch seed", () => {
  const SEED = { model: 'opus', effort: 'high' }

  it('carries the seed create will use when the chat is supported', async () => {
    const seedOptions = vi.fn(() => SEED)
    const response = await call(
      CREATE_SUPPORT.method,
      CREATE_SUPPORT.params,
      MODE_CHOOSING_CLIENT,
      { ...SETTING_ON, structuredAgentSessionLaunchSeedOptions: seedOptions }
    )

    expect(response).toMatchObject({ ok: true, result: { supported: true, seedOptions: SEED } })
    expect(seedOptions).toHaveBeenCalledWith('codex')
  })

  it('carries none when the chat is not supported', async () => {
    const seedOptions = vi.fn(() => SEED)
    const response = await call(
      CREATE_SUPPORT.method,
      CREATE_SUPPORT.params,
      MODE_CHOOSING_CLIENT,
      {
        ...SETTING_ON,
        getStructuredAgentSessionCreateSupport: vi.fn(async () => ({
          supported: false,
          reason: 'wsl'
        })),
        structuredAgentSessionLaunchSeedOptions: seedOptions
      }
    )

    expect(response).toMatchObject({ ok: true, result: { supported: false, reason: 'wsl' } })
    expect(response).not.toMatchObject({ result: { seedOptions: expect.anything() } })
    expect(seedOptions).not.toHaveBeenCalled()
  })
})
