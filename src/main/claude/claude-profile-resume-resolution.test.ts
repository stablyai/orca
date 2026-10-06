import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

describe('isolated account ownership on structured resume', () => {
  it.each([false, true])(
    'requires ownership for a legacy conversation after enrollment (bound: %s)',
    async (bound) => {
      const record = agentSessionRecordFixture()
      if (bound) {
        record.accountHome.claudeAccountId = 'a'
      }
      const policy = vi.fn(() => ({ stripAuthEnv: true }))
      const resolve = createClaudeStructuredLaunchResolver({
        store: { getRecord: () => record },
        resolveWorkspacePath: async () => '/workspace',
        resolveCommand: () => '/test/claude',
        resolveAuthPolicy: policy,
        hasTranscript: async () => true,
        readManagedAccountGate: () => ({
          claudeManagedAccounts: [],
          activeClaudeManagedAccountId: null,
          claudeProfileMigrationAt: 2000
        })
      })
      const identity: AgentSessionJournalIdentity = {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('provider-session-alpha-1', null)
      }
      if (bound) {
        await expect(resolve({ identity })).resolves.toMatchObject({
          claudeConfigDir: record.accountHome.path
        })
        expect(policy).toHaveBeenCalledWith(record.accountHome)
      } else {
        await expect(resolve({ identity })).rejects.toThrow('no verified account binding')
        expect(policy).not.toHaveBeenCalled()
      }
    }
  )
})
