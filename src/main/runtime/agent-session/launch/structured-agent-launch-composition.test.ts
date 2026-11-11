import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { CLAUDE_STRUCTURED_AGENT } from '../../../claude/structured/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../../codex/structured/launch/codex-structured-agent-definition'
import {
  composeStructuredLaunch,
  composeStructuredLaunchRead
} from './structured-agent-launch-composition'
import type { StructuredAgentLaunchSources } from './structured-agent-launch-composition'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

describe('structured launch checkout admission', () => {
  it.each([CLAUDE_STRUCTURED_AGENT, CODEX_STRUCTURED_AGENT])(
    'keeps $agent history readable while refusing a provider start at Git storage',
    async (definition) => {
      const record = agentSessionRecordFixture({
        sessionId: 'chat',
        provider: definition.agent,
        accountHome: { variable: definition.accountHomeVariable!, path: '/account' },
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'repo::/project/.bare',
          workspaceKind: 'git-worktree'
        }
      })
      const sources: StructuredAgentLaunchSources = {
        store: {
          pinLaunchDirectory: vi.fn(),
          selectWritableRecord: () => ({ kind: 'writable', record }),
          requireWritableRecord: () => record
        },
        resolveWorkspacePath: async () => '/project/.bare',
        resolveBaseEnvironment: async () => ({}),
        resolveAgentEnvironment: async () => ({}),
        assertWorkspaceAcceptsLaunch: async () => {
          throw new Error('bare storage')
        }
      }
      const part = vi.fn(async () => ({
        launch: { command: 'agent' },
        env: {},
        inheritedEnvToDelete: []
      }))
      const identity: AgentSessionJournalIdentity = {
        sessionId: 'chat',
        workspaceId: 'repo::/project/.bare',
        hostId: 'local',
        agent: definition.agent,
        providerHandle: null
      }
      await expect(
        composeStructuredLaunch(definition, sources, part)({ identity, spawnToken: 'test-spawn' })
      ).rejects.toThrow('bare storage')
      expect(part).not.toHaveBeenCalled()
      await expect(
        composeStructuredLaunchRead(definition, sources, part)(identity)
      ).resolves.toMatchObject({ cwd: '/project/.bare' })
    }
  )
})
