import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  listEnvironments: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.listEnvironments,
  resolveEnvironment: mocks.resolveEnvironment
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

const {
  deleteRuntimeAiVaultSession,
  getSavedRuntimeAiVaultHostInfos,
  prepareRuntimeAiVaultSessionResume,
  scanRuntimeAiVaultSessions
} = await import('./runtime-session-scanner')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listEnvironments.mockReturnValue([])
  mocks.resolveEnvironment.mockImplementation(() => {
    throw new Error('not saved')
  })
  mocks.callRuntimeEnvironment.mockResolvedValue({
    ok: true,
    result: result([session('runtime:env-1', 'session-1')])
  })
})

describe('runtime AI Vault session scanner', () => {
  it('lists saved runtime environments as runtime execution hosts', () => {
    mocks.listEnvironments.mockReturnValue([
      { id: 'env-1', name: 'Server 1' },
      { id: 'env-2', name: 'Server 2', connectionDependency: 'ssh-tunnel' }
    ])

    expect(getSavedRuntimeAiVaultHostInfos('/user-data')).toEqual([
      { environmentId: 'env-1', executionHostId: 'runtime:env-1' },
      {
        environmentId: 'env-2',
        executionHostId: 'runtime:env-2',
        connectionDependency: 'ssh-tunnel'
      }
    ])
  })

  it('forwards scan options to the runtime transport', async () => {
    await scanRuntimeAiVaultSessions(
      '/user-data',
      'env-1',
      {
        limit: 25,
        force: true,
        historyOwnership: {},
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
        historyOwnership: {},
        scopePaths: ['/srv/app'],
        executionHostId: 'runtime:env-1'
      },
      3000
    )
  })

  it('caps forwarded project paths and reports scope truncation', async () => {
    const scopePaths = Array.from({ length: 80 }, (_, index) => `/srv/repo-${index}`)

    const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      scopePaths
    })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.listSessions',
      expect.objectContaining({ scopePaths: scopePaths.slice(0, 64) }),
      undefined
    )
    expect(scanResult.issues).toContainEqual(
      expect.objectContaining({
        kind: 'scope',
        message: expect.stringContaining('first 64 project paths')
      })
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

  it('keeps full old-server replies and accepts only a marker matching the sent fingerprint', async () => {
    const fingerprint = 'a'.repeat(64)
    const old = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      afterFingerprint: fingerprint
    })
    expect(old.sessions).toHaveLength(1)
    expect(old.unchanged).toBeUndefined()
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: {
        sessions: [],
        issues: [],
        scannedAt: 'fresh',
        fingerprint,
        unchanged: true
      }
    })
    expect(
      await scanRuntimeAiVaultSessions('/user-data', 'env-1', { afterFingerprint: fingerprint })
    ).toMatchObject({ fingerprint, unchanged: true, scannedAt: 'fresh' })
    const invalid = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {
      afterFingerprint: 'b'.repeat(64)
    })
    expect(invalid.unchanged).toBeUndefined()
    expect(invalid.issues[0]?.kind).toBe('host')
  })

  it('prepares a resume on the transcript-owning runtime', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: { useRealCodexHome: true }
    })
    const args = {
      agent: 'codex' as const,
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'runtime:env-1' as const
    }

    await expect(prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', args)).resolves.toEqual({
      useRealCodexHome: true
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.prepareSessionResume',
      args
    )
  })

  it('keeps a repinned account home instead of stripping it', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: {
        useRealCodexHome: false,
        substituteCodexHome: '/data/orca/codex-accounts/account-2/home'
      }
    })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'codex',
        filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'runtime:env-1'
      })
    ).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: '/data/orca/codex-accounts/account-2/home'
    })
  })

  it.each([
    { agent: 'opencode' as const, sessionId: 'opencode-copy' },
    { agent: 'omp' as const, sessionId: 'omp-copy', filePath: '/pinned-omp/sessions/copy.jsonl' }
  ])(
    'preserves the $agent copy identity and transcript across the paired-host response',
    async (forkedSession) => {
      mocks.callRuntimeEnvironment.mockResolvedValueOnce({
        ok: true,
        result: { useRealCodexHome: false, forkedSession }
      })
      await expect(
        prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
          agent: forkedSession.agent === 'opencode' ? 'opencode2' : 'omp',
          sessionId: 'source',
          filePath: '/source',
          codexHome: null,
          executionHostId: 'runtime:env-1',
          fork: true
        })
      ).resolves.toEqual({ useRealCodexHome: false, forkedSession })
    }
  )

  it('fails retryably when runtime preparation returns an invalid result', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: {} })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'codex',
        filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
        codexHome: '/managed',
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('Invalid aiVault.prepareSessionResume response')
  })

  it('emits the desktop sentinel only for this exact missing RPC', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: aiVault.prepareSessionResume' }
    })

    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'claude',
        filePath: '/sessions/a.jsonl',
        codexHome: null,
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('aiVault.prepareSessionResume: method_not_found')

    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: terminal.send' }
    })
    await expect(
      prepareRuntimeAiVaultSessionResume('/user-data', 'env-1', {
        agent: 'claude',
        filePath: '/sessions/a.jsonl',
        codexHome: null,
        executionHostId: 'runtime:env-1'
      })
    ).rejects.toThrow('Unknown method: terminal.send')
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

describe('deleteRuntimeAiVaultSession', () => {
  const args = {
    agent: 'claude' as const,
    sessionId: 'session-1',
    filePath: '/home/ada/.claude/projects/-repo/session-1.jsonl',
    executionHostId: 'runtime:env-1' as const
  }

  it('sends only the row identity; the owning host validates the path', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: { outcome: 'deleted' } })

    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'deleted'
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.deleteSession',
      { agent: 'claude', sessionId: 'session-1', filePath: args.filePath },
      undefined,
      undefined
    )
  })

  it('fences the delete to the pairing the user confirmed against', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: { outcome: 'deleted' } })

    await deleteRuntimeAiVaultSession('/user-data', 'env-1', {
      ...args,
      expectedEnvironmentPairingRevision: 7
    })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'aiVault.deleteSession',
      { agent: 'claude', sessionId: 'session-1', filePath: args.filePath },
      undefined,
      7
    )
  })

  it('asks for a host update only when the host lacks this exact RPC', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: aiVault.deleteSession' }
    })
    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'rejected',
      agent: 'claude',
      reason: 'host-update-required'
    })

    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: 'Remote Orca server is unavailable.' }
    })
    await expect(deleteRuntimeAiVaultSession('/user-data', 'env-1', args)).resolves.toEqual({
      outcome: 'failed',
      agent: 'claude',
      error: 'Remote Orca server is unavailable.'
    })
  })
})

describe('runtime row pairing stamp', () => {
  it("stamps rows with this desktop's pairing, never the host's own claim", async () => {
    mocks.resolveEnvironment.mockReturnValue({ id: 'env-1', createdAt: 1, pairingRevision: 9 })
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: result([{ ...session('runtime:env-1', 'session-1'), hostPairingRevision: 3 }])
    })

    const listed = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

    expect(listed.sessions.map((row) => row.hostPairingRevision)).toEqual([9])
  })
})
