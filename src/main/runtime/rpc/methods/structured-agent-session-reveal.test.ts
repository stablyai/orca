import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
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
})
