import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineMethod } from '../core'
import { OptionsParams } from './structured-agent-session-schemas'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'
function conversation(workspaceId = 'workspace-1', agent: 'claude' | 'codex' = 'codex') {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('Host fixture must be installed')
  }
  const record = agentSessionRecordFixture()
  vi.spyOn(host.deps.store, 'getConversation').mockReturnValue(
    agentSessionConversationView({
      ...record,
      sessionId: SESSION,
      provider: agent,
      location: { ...record.location, workspaceId }
    })
  )
}
beforeEach(() => {
  installStructuredHostStub()
  conversation()
})
afterEach(() => clearStructuredHostStub())

describe('agentSession.reveal', () => {
  it.each(['codex', 'claude'] as const)('republishes a persisted %s chat tab', async (agent) => {
    conversation('workspace-1', agent)
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent,
      readable: true
    })

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(hostCalls.revealSession).toHaveBeenCalledWith(SESSION)
    expect(response).toMatchObject({ ok: true, result: { ok: true, agent } })
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent, activate: true })
    )
  })

  it('publishes the workspace the host reported, not one the client could assert', async () => {
    // The client sends only a session id, so a stale or forged one cannot aim the publish at
    // another workspace.
    conversation('workspace-from-record', 'claude')
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-from-record',
      agent: 'claude',
      readable: true
    })

    await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith({
      workspaceId: 'workspace-from-record',
      sessionId: SESSION,
      agent: 'claude',
      activate: true,
      capture: expect.any(Function),
      workspaceAuthority: expect.objectContaining({
        check: expect.any(Function),
        current: expect.any(Function),
        committed: expect.any(Function),
        saving: expect.any(Function)
      })
    })
  })

  it('publishes the tab even when the journal could not be read', async () => {
    // Publish unreadable chats too: attach can recover them; refusing reveal would strand them permanently.
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent: 'codex',
      readable: false
    })

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: true, result: { ok: true, readable: false } })
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledOnce()
  })

  it('refuses rather than throws when the host holds no such record', async () => {
    hostCalls.revealSession.mockRejectedValueOnce(new Error('agent_session_identity_required'))

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_identity_required' } }
    })
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it('does not launder an unrelated fault into a refusal', async () => {
    hostCalls.revealSession.mockRejectedValueOnce(new Error('EACCES: journal directory'))

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: false })
  })

  it('rejects caller mode before host effects without a proven device, and on the historical strict parser', async () => {
    const params = { sessionId: SESSION, navigation: 'caller' }
    const unproved = await call('agentSession.reveal', params, STRUCTURED_MOBILE_CLIENT)
    expect(unproved.ok).toBe(false)
    expect(hostCalls.revealSession).not.toHaveBeenCalled()
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
    const handler = vi.fn()
    const legacy = defineMethod({
      name: 'agentSession.reveal',
      permission: 'workspace',
      params: OptionsParams,
      handler
    })
    expect(
      await call('agentSession.reveal', params, STRUCTURED_CLIENT, {}, [legacy])
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('is refused for a client that cannot read structured sessions', async () => {
    const response = await call(
      'agentSession.reveal',
      { sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(response).toMatchObject({ ok: false })
    expect(hostCalls.revealSession).not.toHaveBeenCalled()
  })
})
