import { describe, expect, it } from 'vitest'
import { OrchestrationRequestEvidence } from './orchestration-compatibility-envelope'

const CHAT = '55555555-5555-4555-8555-555555555555'

describe('the session a connector call names', () => {
  it('is sent with a bot chat’s reply, reaction and action, so the host can verify the chat', () => {
    const evidence = new OrchestrationRequestEvidence({ ORCA_AGENT_SESSION_ID: CHAT })
    for (const method of ['connector.act', 'connector.reply', 'connector.react']) {
      expect(
        evidence.envelopeFor(method, { remote: false, mutation: true, requestId: undefined })
          .orchestrationCompatibilityEvidence?.agentSessionId
      ).toBe(CHAT)
      // A session id names a chat only on its own host.
      expect(
        evidence.envelopeFor(method, { remote: true, mutation: true, requestId: undefined })
          .orchestrationCompatibilityEvidence
      ).toBeUndefined()
    }
  })
})
