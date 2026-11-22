import { describe, expect, it } from 'vitest'
import { OrchestrationRequestEvidence } from './orchestration-compatibility-envelope'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const local = { remote: false, mutation: true, requestId: undefined }

describe('OrchestrationRequestEvidence', () => {
  it.each(['connector.act', 'connector.reply'])(
    'sends the calling chat’s session with %s, so the host can check it posts only for itself',
    (method) => {
      const evidence = new OrchestrationRequestEvidence({ ORCA_AGENT_SESSION_ID: SESSION })
      expect(evidence.envelopeFor(method, local)).toEqual({
        orchestrationCompatibilityEvidence: { agentSessionId: SESSION }
      })
    }
  )
})
