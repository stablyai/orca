import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const { isWindowsProcessStartTimeAvailable } = vi.hoisted(() => ({
  isWindowsProcessStartTimeAvailable: vi.fn(() => true)
}))

vi.mock('../../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable
}))

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
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
  })
}

describe('codex structured launch resolution', () => {
  it('resumes a chat on the account selected after it was created, bringing its thread along', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-chat-account-move-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    try {
      const threadId = '019a1a83-f690-7c82-a482-31195524a7d8'
      const rollout = join(
        'sessions',
        '2026',
        '11',
        '04',
        `rollout-2026-11-04T20-28-46-${threadId}.jsonl`
      )
      const oldHome = join(root, 'account-a')
      const newHome = join(root, 'account-b')
      mkdirSync(join(oldHome, 'sessions', '2026', '11', '04'), { recursive: true })
      writeFileSync(join(oldHome, rollout), '{"type":"session_meta"}\n')
      const prepareLaunchAccountHome = vi.fn(async () => ({
        variable: 'CODEX_HOME' as const,
        path: newHome
      }))
      const launch = await createCodexStructuredLaunchResolver({
        store: {
          getRecord: () =>
            record({
              accountHome: { variable: 'CODEX_HOME', path: oldHome },
              providerHandleChain: [
                {
                  linkId: 'link-1',
                  handle: codexProviderHandle(threadId),
                  origin: 'created',
                  mintedAtFence: 1,
                  observedAt: 1
                }
              ]
            }),
          pinLaunchDirectory: vi.fn()
        },
        resolveWorkspacePath: async (id) => `/repos/${id}`,
        resolveCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
        resolveLaunchArgs: () => [],
        prepareLaunchAccountHome
      })({ identity: IDENTITY })

      expect(prepareLaunchAccountHome).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        '/repos/workspace-1'
      )
      expect(launch.codexHome).toBe(newHome)
      expect(launch.env.CODEX_HOME).toBe(newHome)
      expect(launch.resumeThreadId).toBe(threadId)
      expect(readFileSync(join(newHome, rollout), 'utf8')).toBe('{"type":"session_meta"}\n')
    } finally {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
