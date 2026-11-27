import { describe, expect, it } from 'vitest'
import { readAgentSessionErrorRefusal } from '../../../../src/shared/agent-session/failures/agent-session-write-failure'
import { requireRpcResultOrThrowMessage } from './rpc-acceptance-policies'

describe('requireRpcResultOrThrowMessage', () => {
  it('keeps the refusal a host sent with its error, so the phone can say why', () => {
    // A bot chat refused on a host whose Hermes is too old (#46746).
    const refusal = {
      code: 'structured_agent_session_unsupported',
      details: {
        reason: 'hostUnsupported',
        agentInstallation: { agent: 'hermes', installedVersion: '0.20.5', minimumVersion: '0.23.0' }
      }
    }

    let thrown: unknown
    try {
      requireRpcResultOrThrowMessage({
        id: 'r1',
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.',
          data: { refusal }
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown instanceof Error && thrown.message).toBe(
      'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.'
    )
    expect(readAgentSessionErrorRefusal(thrown)).toEqual(refusal)
  })
})
