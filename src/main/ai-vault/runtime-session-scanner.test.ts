import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  listEnvironments: vi.fn()
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.listEnvironments
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

const { getSavedRuntimeAiVaultHostInfos, scanRuntimeAiVaultSessions } =
  await import('./runtime-session-scanner')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listEnvironments.mockReturnValue([])
  mocks.callRuntimeEnvironment.mockResolvedValue({
    ok: true,
    result: result([session('runtime:env-1', 'session-1')])
  })
})

describe('runtime AI Vault session scanner', () => {
  it('lists saved runtime environments as runtime execution hosts', () => {
    mocks.listEnvironments.mockReturnValue([
      { id: 'env-1', name: 'Server 1' },
      { id: 'env-2', name: 'Server 2' }
    ])

    expect(getSavedRuntimeAiVaultHostInfos('/user-data')).toEqual([
      { environmentId: 'env-1', executionHostId: 'runtime:env-1' },
      { environmentId: 'env-2', executionHostId: 'runtime:env-2' }
    ])
  })

  it('forwards scan options to the runtime transport', async () => {
    await scanRuntimeAiVaultSessions(
      '/user-data',
      'env-1',
      {
        limit: 25,
        force: true,
        scopePaths: ['/srv/app']
      },
      { timeoutMs: 3000 }
    )

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      {
        limit: 25,
        force: true,
        scopePaths: ['/srv/app'],
        executionHostId: 'runtime:env-1'
      },
      3000
    )
  })

  it('stamps sessions and issues returned for a different execution host', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: result(
        [session('local', 'session-1')],
        [
          {
            executionHostId: 'ssh:dev-box',
            agent: 'codex',
            path: '/sessions/session-1.jsonl',
            message: 'could not parse session'
          }
        ]
      )
    })

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(scanResult.sessions).toEqual([
      expect.objectContaining({
        id: 'runtime:env-1:codex:session-1:/sessions/session-1.jsonl',
        executionHostId: 'runtime:env-1'
      })
    ])
    expect(scanResult.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'runtime:env-1',
        agent: 'codex',
        path: '/sessions/session-1.jsonl'
      })
    ])
  })

  it('stamps accepted sessions with the requested runtime host', async () => {
    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(scanResult.sessions).toEqual([
      expect.objectContaining({
        id: 'runtime:env-1:codex:session-1:/sessions/session-1.jsonl',
        executionHostId: 'runtime:env-1'
      })
    ])
  })
})

function result(
  sessions: AiVaultSession[],
  issues: AiVaultListResult['issues'] = []
): AiVaultListResult {
  return { sessions, issues, scannedAt: '2026-07-04T00:00:00.000Z' }
}

function session(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/sessions/${sessionId}.jsonl`,
    executionHostId,
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/srv/app',
    branch: null,
    model: null,
    filePath: `/sessions/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-07-04T03:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
