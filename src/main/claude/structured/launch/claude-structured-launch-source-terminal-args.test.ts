import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const SESSION_ID = 'orca-session-1'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  hostId: LOCAL_EXECUTION_HOST_ID,
  agent: 'claude',
  providerHandle: null
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: [],
    ...overrides
  })
}

function identityAt(leafUuid: string | null): typeof IDENTITY {
  return {
    ...IDENTITY,
    providerHandle: claudeProviderHandle('provider-current', leafUuid)
  }
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveEnv?: () => Record<string, string>,
  account: 'managed' | 'system' = 'system',
  hasTranscript: () => Promise<boolean> = async () => true,
  resolveLaunchArgs?: () => string[],
  attachmentDirectory?: string
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account }),
    hasTranscript,
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? []),
    ...(resolveEnv ? { resolveEnv } : {}),
    ...(attachmentDirectory ? { attachmentDirectory } : {})
  })
}

const RESUMABLE = record({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
  providerHandleChain: [
    { handle: claudeProviderHandle('provider-current', 'leaf-current') }
  ] as AgentSessionRecord['providerHandleChain']
})

describe('claude structured launch resolution', () => {
  it('resumes the same conversation with the continued terminal flags added to the configured ones', async () => {
    const resolve = resolverFor(
      record({
        providerHandleChain: RESUMABLE.providerHandleChain,
        sourceTerminalArgs: [
          '--mcp-config',
          '/work/mcp.json',
          '--dangerously-load-development-channels',
          'server:relay',
          '--model',
          'opus',
          '--add-dir',
          '/shared',
          '--dangerously-skip-permissions',
          '--resume',
          'old-terminal-session',
          '--fork-session'
        ]
      }),
      undefined,
      'system',
      async () => true,
      () => ['--model', 'sonnet', '--add-dir', '/shared', '--strict-mcp-config']
    )

    const launch = await resolve({ identity: identityAt('leaf-current') })

    expect(launch.options.resume).toBe('provider-current')
    expect(launch.options.forkSession).toBeUndefined()
    expect(launch.options.additionalDirectories).toEqual(['/shared'])
    expect(launch.options.extraArgs).toEqual({
      'mcp-config': '/work/mcp.json',
      'dangerously-load-development-channels': 'server:relay',
      model: 'opus',
      'strict-mcp-config': null,
      'replay-user-messages': null
    })
  })
})
