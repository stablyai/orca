import { describe, expect, it, vi } from 'vitest'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from './acp-launch-registry'

const gemini = acpLaunchSpecFor('gemini')
if (!gemini) {
  throw new Error('Gemini ACP launch spec is missing')
}
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  providerHandle: null
}

describe('Gemini ACP resume boundary', () => {
  it.each([
    ['an exchanged turn', async () => true],
    [
      'an unreadable journal',
      () => {
        throw new Error('unreadable')
      }
    ]
  ])(
    'refuses a created Gemini handle with %s before any environment lookup',
    async (_label, hasProviderTurn) => {
      const record: AgentSessionRecord = {
        ...agentSessionRecordFixture(),
        provider: 'gemini',
        accountHome: { variable: 'GEMINI_CLI_HOME', path: '/accounts/gemini' },
        providerHandleChain: [
          {
            linkId: 'created-link',
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1,
            handle: { transport: 'acp', agent: 'gemini', nativeId: 'acp-1' }
          }
        ]
      }
      const resolveEnvironment = vi.fn(async () => ({}))
      const resolve = createAcpStructuredLaunchResolver(gemini, {
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        savedSession: { hasProviderTurn },
        resolveEnvironment
      })
      await expect(resolve({ identity: { ...identity, agent: 'gemini' } })).rejects.toMatchObject({
        name: 'AgentSessionPreSpawnError',
        reason: 'providerResumeUnavailable'
      })
      expect(resolveEnvironment).not.toHaveBeenCalled()
    }
  )
})
