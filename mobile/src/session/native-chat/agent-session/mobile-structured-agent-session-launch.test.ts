import { describe, expect, it } from 'vitest'
import { forkMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'

describe('forkMobileStructuredAgentSession', () => {
  it('creates the fork without the createSupport probe a terminal-default host refuses', async () => {
    const calls: { method: string; params: unknown }[] = []
    // A terminal-default host refuses createSupport for a phone without client-launch-mode.
    const client = stubRpcClient({
      sendRequest: async (method, params) => {
        calls.push({ method, params })
        return method === 'agentSession.createSupport'
          ? {
              id: 'support',
              ok: false,
              error: {
                code: 'structured_agent_session_unsupported',
                message: 'clientCapabilityMissing'
              }
            }
          : { id: 'create', ok: true, result: { ok: true, value: { sessionId: 'fork-1' } } }
      }
    })
    const forkFrom = { sessionId: 'source-session', throughItemId: 'item-42' }

    const result = await forkMobileStructuredAgentSession(
      client,
      'folder:bot-home',
      'claude',
      forkFrom
    )

    expect(result).toEqual({ kind: 'created', sessionId: 'fork-1' })
    expect(calls.map((call) => call.method)).toEqual(['agentSession.create'])
    expect(calls[0]?.params).toMatchObject({ worktree: 'id:folder:bot-home', forkFrom })
  })
})
