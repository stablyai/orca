import { describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

import type { RpcContext } from '../core'
import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from './structured-agent-session-agents'

const [method] = STRUCTURED_AGENT_SESSION_AGENTS_METHODS

const ensureStructuredAgentSessionHost = vi.fn(async () => {
  throw new Error('the journal would not open')
})

function context(overrides: Partial<RpcContext>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the caller's capabilities; the runtime stub proves it never installs the host.
  return { runtime: { ensureStructuredAgentSessionHost }, ...overrides } as unknown as RpcContext
}

describe('agentSession.agents', () => {
  it('still refuses a remote client that cannot read structured sessions', async () => {
    await expect(
      method.handler({}, context({ clientKind: 'mobile', clientCapabilities: [] }))
    ).rejects.toMatchObject({ refusal: { code: 'structured_agent_session_unsupported' } })
    await expect(
      method.handler(
        {},
        context({
          clientKind: 'mobile',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        })
      )
    ).resolves.toMatchObject({ agents: expect.any(Array) })
  })
})
