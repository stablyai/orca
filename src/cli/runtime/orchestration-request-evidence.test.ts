import { describe, expect, it } from 'vitest'
import { OrchestrationRequestEvidence } from './orchestration-compatibility-envelope'

const CHAT = { ORCA_AGENT_SESSION_ID: '11111111-1111-4111-8111-111111111111' }

describe('caller evidence on requests to another server', () => {
  it('sends a chat read there like a shell, with no session id', () => {
    const evidence = new OrchestrationRequestEvidence(CHAT)
    expect(
      evidence.envelopeFor('orchestration.inbox', {
        remote: true,
        mutation: false,
        requestId: undefined
      }).orchestrationCompatibilityEvidence
    ).toBeUndefined()
  })

  it('keeps the session id on writes there, so that server still refuses them', () => {
    const evidence = new OrchestrationRequestEvidence(CHAT)
    expect(
      evidence.envelopeFor('orchestration.taskCreate', {
        remote: true,
        mutation: true,
        requestId: 'request_1'
      }).orchestrationCompatibilityEvidence
    ).toEqual({ agentSessionId: '11111111-1111-4111-8111-111111111111' })
  })
})
