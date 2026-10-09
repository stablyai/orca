import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { vi } from 'vitest'
import { record as savedRecord } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'
export const SESSION_ID = 'session-1'
export const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: null
}
export function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...savedRecord({ chain: [] }),
    sessionId: SESSION_ID,
    provider: 'codex',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: [],
    ...overrides
  }
}

export function resolverFor(
  value: AgentSessionRecord | null,
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`,
  resolveRollout: () => Promise<string | null> = async () => null,
  resolveLaunchArgs?: () => string[]
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex',
    resolveRollout,
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? [])
  })
}
