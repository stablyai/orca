import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('Cursor structured RPC capability', () => {
  it('refuses Cursor provider aliases from a client that only negotiated the old lane', async () => {
    const response = await call(
      'agentSession.ensure',
      attachParams({
        provider: 'cursor',
        accountHome: { variable: 'CURSOR_CONFIG_DIR', path: '/cursor' },
        providerHandle: { kind: 'cursor', sessionId: 'cursor-provider' }
      }),
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })
  it('accepts a Cursor attach only when the client negotiated it', async () => {
    const response = await call(
      'agentSession.ensure',
      attachParams({
        agent: 'cursor',
        provider: 'cursor',
        accountHome: { variable: 'CURSOR_CONFIG_DIR', path: '/cursor' },
        providerHandle: { kind: 'cursor', sessionId: 'cursor-provider' }
      }),
      {
        ...STRUCTURED_CLIENT,
        clientCapabilities: [
          ...STRUCTURED_CLIENT.clientCapabilities,
          CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
        ]
      }
    )
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.attach).toHaveBeenCalledOnce()
  })
  it('gates an existing Cursor journal and new work but still admits cleanup', async () => {
    hostCalls.sessionAgent.mockReturnValue('cursor')
    expect(
      (
        await call(
          'agentSession.history',
          { sessionId: SESSION, direction: 'tail' },
          STRUCTURED_CLIENT
        )
      ).ok
    ).toBe(false)
    expect(hostCalls.history).not.toHaveBeenCalled()
    expect((await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)).ok).toBe(
      true
    )
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION, 'user-close')
  })
})

describe('Cursor aggregate status capability', () => {
  it('omits Cursor snapshot rows from an older structured client', async () => {
    hostCalls.subscribeStatus.mockImplementationOnce(
      (subscriber: StructuredAgentSessionStatusSubscriber) => {
        subscriber.emit({
          type: 'snapshot',
          sessions: [
            {
              sessionId: 'cursor',
              workspaceId: 'folder',
              agent: 'cursor',
              status: null,
              latestPrompt: '',
              updatedAt: 1
            }
          ]
        })
        return () => {}
      }
    )
    expect(await call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT)).toMatchObject({
      ok: true,
      result: { type: 'snapshot', sessions: [] }
    })
  })
})
