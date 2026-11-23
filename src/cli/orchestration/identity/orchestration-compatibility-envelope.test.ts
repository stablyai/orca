import { describe, expect, it } from 'vitest'
import {
  createOrchestrationCompatibilityEnvelope,
  OrchestrationRequestEvidence
} from './orchestration-compatibility-envelope'

describe('structured session job evidence', () => {
  it('uses the scrub-safe proof when provider shells remove TOKEN environment names', () => {
    const envelope = createOrchestrationCompatibilityEnvelope({
      ORCA_AGENT_SESSION_ID: 'session',
      ORCA_AGENT_SESSION_PROOF: 'spawn-proof'
    })
    expect(envelope.orchestrationCompatibilityEvidence).toEqual({
      agentSessionId: 'session',
      agentSessionSpawnToken: 'spawn-proof'
    })
    const requests = new OrchestrationRequestEvidence({
      ORCA_AGENT_SESSION_ID: 'session',
      ORCA_AGENT_SESSION_PROOF: 'spawn-proof'
    })
    const request = { remote: false, mutation: false, requestId: undefined }
    for (const method of ['github.createIssue', 'terminal.create', 'terminal.split']) {
      expect(requests.envelopeFor(method, request)).toEqual({
        orchestrationCompatibilityEvidence: {
          agentSessionId: 'session',
          agentSessionSpawnToken: 'spawn-proof'
        }
      })
      expect(requests.envelopeFor(method, { ...request, remote: true })).toEqual({})
    }
    expect(
      requests.envelopeFor('orchestration.status', { ...request, remote: true })
        .orchestrationCompatibilityEvidence
    ).toBeUndefined()
  })

  it('requires a session identity and prefers its canonical current proof', () => {
    expect(
      createOrchestrationCompatibilityEnvelope({ ORCA_AGENT_SESSION_PROOF: 'stale' })
        .orchestrationCompatibilityEvidence
    ).toBeUndefined()
    expect(
      createOrchestrationCompatibilityEnvelope({
        ORCA_AGENT_SESSION_ID: 'session',
        ORCA_AGENT_SESSION_SPAWN_TOKEN: 'current',
        ORCA_AGENT_SESSION_PROOF: 'stale'
      }).orchestrationCompatibilityEvidence
    ).toEqual({ agentSessionId: 'session', agentSessionSpawnToken: 'current' })
  })
})
