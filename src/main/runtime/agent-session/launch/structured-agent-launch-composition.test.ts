import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_SCRUB_SAFE_PANE_ENV } from '../../../../shared/agent-hook-listener/transport/agent-hook-scrub-safe-env'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { resolveProviderChildEnv } from '../../../provider-process/provider-process-launch'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  createCodexStructuredLaunchResolver,
  TEST_SPAWN_TOKEN
} from './structured-agent-launch-composition.test-support'

afterEach(() => {
  structuredWorkerIdentities.clear()
})

const INHERITED_PANE_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/work',
  ORCA_PANE_KEY: 'tab_parent:parent-pane',
  ORCA_TAB_ID: 'tab_parent',
  ORCA_WORKTREE_ID: 'parent-worktree',
  ORCA_WORKSPACE_ID: 'parent-workspace',
  ORCA_TERMINAL_HANDLE: 'term_parent',
  ORCA_AGENT_LAUNCH_TOKEN: 'parent-launch-token',
  [ORCA_SCRUB_SAFE_PANE_ENV]: 'parent-scrub-safe-pane',
  ORCA_AGENT_HOOK_PORT: '43123'
}

function makeIdentity(
  sessionId: string,
  agent: 'claude' | 'codex' | 'grok' | 'pi'
): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: LOCAL_EXECUTION_HOST_ID,
    agent,
    providerHandle: null
  }
}

function makeStore(
  sessionId: string,
  provider: 'claude' | 'codex' | 'grok' | 'pi',
  accountHome: AgentSessionAccountHome
) {
  const record = agentSessionRecordFixture({
    sessionId,
    provider,
    accountHome
  })
  return { getRecord: () => record, pinLaunchDirectory: vi.fn() }
}

function expectNoHostPaneIdentity(childEnv: NodeJS.ProcessEnv): void {
  expect(childEnv).not.toHaveProperty('ORCA_PANE_KEY')
  expect(childEnv).not.toHaveProperty('ORCA_TAB_ID')
  expect(childEnv).not.toHaveProperty('ORCA_WORKTREE_ID')
  expect(childEnv).not.toHaveProperty('ORCA_WORKSPACE_ID')
  expect(childEnv).not.toHaveProperty('ORCA_AGENT_LAUNCH_TOKEN')
  expect(childEnv).not.toHaveProperty(ORCA_SCRUB_SAFE_PANE_ENV)
  expect(childEnv).not.toHaveProperty('ORCA_AGENT_HOOK_PORT')
}

describe('structured agent launch composition pane-identity stripping', () => {
  it("preserves a structured worker's own ORCA_TERMINAL_HANDLE while stripping host pane identity", async () => {
    const sessionId = '00000000-0000-4000-8000-000000000005'
    const workerHandle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle: workerHandle,
      sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: `structured:${sessionId}`,
      worktreeId: 'workspace-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    const workerLaunch = await createCodexStructuredLaunchResolver({
      store: makeStore(sessionId, 'codex', {
        variable: 'CODEX_HOME',
        path: '/home/work/.codex'
      }),
      resolveEnvironment: async () => ({ ...INHERITED_PANE_ENV }),
      resolveCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
      resolveLaunchArgs: () => []
    })({
      identity: makeIdentity(sessionId, 'codex'),
      spawnToken: TEST_SPAWN_TOKEN
    })

    const childEnv = resolveProviderChildEnv(workerLaunch, INHERITED_PANE_ENV)
    expectNoHostPaneIdentity(childEnv)
    expect(childEnv.ORCA_TERMINAL_HANDLE).toBe(workerHandle)
  })
})
