import { expect, it } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionCreateIntentFingerprint } from './structured-agent-session-create'

it('verifies profile-bound create fingerprints on the host', () => {
  const request = structuredAgentSessionCreateParams({
    sessionId: 'claude_session1',
    worktree: 'folder:workspace',
    agent: 'claude',
    agentProfileId: 'work',
    now: 1_800_000_000_000,
    randomUuid: () => '00000000-0000-4000-8000-000000000001'
  })
  expect(request.envelope.payloadFingerprint).toBe(
    structuredAgentSessionCreateIntentFingerprint(request)
  )
  expect(request.envelope.payloadFingerprint).not.toBe(
    structuredAgentSessionCreateIntentFingerprint({
      ...request,
      agentProfileId: 'personal'
    })
  )
})
