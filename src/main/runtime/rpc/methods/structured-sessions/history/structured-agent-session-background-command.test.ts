import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const membership = vi.hoisted(() => ({ current: true }))
vi.mock('../../../../../bots/bot-group-session-access', async (original) => ({
  ...(await original<object>()),
  assertBotGroupSessionAccess: () => {
    if (!membership.current) {
      throw new Error('This bot is no longer a member of the group.')
    }
  }
}))

import { STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHODS } from './structured-agent-session-background-command'
import { BackgroundCommandParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  hostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'
import {
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from '../protocol/structured-agent-session-rpc-client.test-fixture'
import {
  CHANNEL_SESSION,
  commandDetailChannel
} from '../../../../../native-chat/agent-session-wire/command-details/structured-command-detail-channel.test-fixture'

const METHOD = 'agentSession.backgroundCommand'

let install: ReturnType<typeof vi.fn>
let h: ReturnType<typeof commandDetailChannel>
let params: {
  sessionId: string
  childWorkId: string
  invocation: { invocationId: string; generation: number }
}

/** Through the real dispatcher and gate; the runtime records any attempt to install a host. */
function read(client: Parameters<typeof call>[2] = STRUCTURED_CLIENT, input: unknown = params) {
  return call(METHOD, input, client, { ensureStructuredAgentSessionHost: install }, [
    ...STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHODS
  ])
}

function installWarmHost(): void {
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      sessionAgent: () => 'codex',
      commandDetail: (sessionId: string, tuple: Parameters<typeof h.channel.commandDetail>[1]) =>
        h.channel.commandDetail(sessionId, tuple)
    })
  )
}

beforeEach(() => {
  membership.current = true
  install = vi.fn(async () => {
    throw new Error('a command read must never install a host')
  })
  h = commandDetailChannel()
  const [tuple] = h.tuples()
  params = {
    sessionId: CHANNEL_SESSION,
    childWorkId: tuple!.childWorkId,
    invocation: { invocationId: tuple!.invocationId, generation: tuple!.generation }
  }
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.backgroundCommand', () => {
  it('cold: answers null and installs nothing', async () => {
    clearStructuredHostStub()
    await expect(read()).resolves.toMatchObject({ ok: true, result: { command: null } })
    expect(install).not.toHaveBeenCalled()
  })

  it('stopping or stopped: answers null and never re-installs', async () => {
    installWarmHost()
    await expect(read()).resolves.toMatchObject({ result: { command: expect.any(String) } })
    // Teardown clears the registry before anything else, as runtime stop does.
    setStructuredAgentSessionHost(null)
    await expect(read()).resolves.toMatchObject({ ok: true, result: { command: null } })
    expect(install).not.toHaveBeenCalled()
  })

  it('warm: returns the landed exact bytes for the exact tuple only', async () => {
    installWarmHost()
    await expect(read()).resolves.toMatchObject({
      ok: true,
      result: { command: h.exact.get(params.childWorkId) }
    })
    await expect(
      read(STRUCTURED_CLIENT, {
        ...params,
        invocation: { ...params.invocation, generation: params.invocation.generation + 1 }
      })
    ).resolves.toMatchObject({ result: { command: null } })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses a retired group member, warm or cold, without installing', async () => {
    membership.current = false
    installWarmHost()
    await expect(read()).resolves.toMatchObject({ ok: false })
    clearStructuredHostStub()
    await expect(read()).resolves.toMatchObject({ ok: false })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses every phone and a client without structured support, without installing', async () => {
    installWarmHost()
    await expect(read(STRUCTURED_MOBILE_CLIENT)).resolves.toMatchObject({ ok: false })
    await expect(read({ clientKind: 'runtime', clientCapabilities: [] })).resolves.toMatchObject({
      ok: false
    })
    expect(install).not.toHaveBeenCalled()
  })

  it('answers null for a session whose agent is not Codex', async () => {
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), { sessionAgent: () => 'claude', commandDetail: () => 'leak' })
    )
    // Null or an audience refusal, never the bytes.
    expect(JSON.stringify(await read())).not.toContain('leak')
  })

  it('takes strictly bounded params only', () => {
    expect(BackgroundCommandParams.safeParse(params).success).toBe(true)
    expect(BackgroundCommandParams.safeParse({ ...params, extra: 1 }).success).toBe(false)
    expect(
      BackgroundCommandParams.safeParse({
        ...params,
        invocation: { invocationId: 'r', generation: 0 }
      }).success
    ).toBe(false)
    expect(
      BackgroundCommandParams.safeParse({ ...params, childWorkId: 'x'.repeat(257) }).success
    ).toBe(false)
  })
})
