import { describe, expect, it } from 'vitest'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'

function buildEvent(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' },
    ...overrides
  }
}

describe('relay hook envelope working directory (STA-5804)', () => {
  it('forwards the remote agent directory so the client can resume there', () => {
    const envelope = buildRelayHookEnvelope(
      buildEvent({ agentCwd: '/srv/checkout/packages/api' }),
      'claude'
    )

    expect(envelope.agentCwd).toBe('/srv/checkout/packages/api')
  })

  it('omits the directory when the remote agent reported none', () => {
    const envelope = buildRelayHookEnvelope(buildEvent(), 'claude')

    expect(envelope.agentCwd).toBeUndefined()
  })
})
