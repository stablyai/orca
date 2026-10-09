import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { vi } from 'vitest'
import { record as savedRecord } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
export const SESSION_ID = 'orca-session-1'
export const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: null
}
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
export function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...savedRecord({ chain: [] }),
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
  }
}

export function identityAt(leafUuid: string | null): typeof IDENTITY {
  return {
    ...IDENTITY,
    providerHandle: claudeProviderHandle('provider-current', leafUuid)
  }
}

export function makeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755)
  }
}

export function resolverFor(
  value: AgentSessionRecord | null,
  resolveEnv?: () => Record<string, string>,
  stripAuthEnv = false,
  hasTranscript: () => Promise<boolean> = async () => true,
  resolveLaunchArgs?: () => string[],
  attachmentDirectory?: string
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv }),
    hasTranscript,
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? []),
    ...(resolveEnv ? { resolveEnv } : {}),
    ...(attachmentDirectory ? { attachmentDirectory } : {})
  })
}
