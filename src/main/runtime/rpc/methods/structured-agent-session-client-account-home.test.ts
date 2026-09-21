// `accountHome.binding` decides which host-side account gates a launch runs. It is host-set, and
// the attach-shaped entries take their whole payload from the client — so the wire boundary is
// where a client-supplied marker has to stop.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

const CLIENT_BOUND_HOME = attachParams({
  provider: 'claude',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null },
  accountHome: {
    variable: 'CLAUDE_CONFIG_DIR',
    path: '/home/dev/.claude-other',
    binding: { kind: 'project-group', groupId: 'anything' }
  }
})

describe('client-supplied account-home binding', () => {
  it.each([
    ['agentSession.ensure', STRUCTURED_CLIENT],
    ['agentSession.ensure', STRUCTURED_MOBILE_CLIENT],
    ['agentSession.create', STRUCTURED_CLIENT]
  ] as const)('strips the binding a client sent to %s', async (method, client) => {
    const response = await call(method, CLIENT_BOUND_HOME, client)

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.attach).toHaveBeenCalled()
    const attached = hostCalls.attach.mock.calls.at(-1)?.[1]
    expect(attached.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/home/dev/.claude-other'
    })
  })

  it('leaves an account home without a binding byte-identical', async () => {
    await call('agentSession.ensure', attachParams(), STRUCTURED_CLIENT)

    expect(hostCalls.attach.mock.calls.at(-1)?.[1].accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/home/dev/.codex'
    })
  })
})
