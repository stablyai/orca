import { describe, expect, it } from 'vitest'
import {
  createOrchestrationCompatibilityEnvelope,
  localJobEvidence
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
    expect(localJobEvidence(envelope, true)).toEqual({})
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
