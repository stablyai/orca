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

const {
  findRuntimeOwningSshAiVaultHost,
  listRuntimeOwnedSshAiVaultTargets,
  resetRuntimeOwnedSshOwnerCacheForTests,
  scanRuntimeOwnedSshAiVaultSessions
} = await import('./runtime-owned-ssh-session-list')

beforeEach(() => {
  vi.clearAllMocks()
  resetRuntimeOwnedSshOwnerCacheForTests()
  mocks.listEnvironments.mockReturnValue([{ id: 'hub-runtime' }])
  mocks.callRuntimeEnvironment.mockResolvedValue({
    ok: true,
    result: { targets: [{ id: 'hub-owned-host', label: 'Hub host' }] }
  })
})

describe('runtime-owned SSH AI Vault inventory', () => {
  it('lists SSH targets owned by a paired runtime and skips recipe-VM ids', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: {
        targets: [
          { id: 'hub-owned-host', label: 'Hub host', connected: true },
          { id: 'offline-host', label: 'Offline', connected: false },
          { id: 'runtime-ssh-recipe', label: 'Recipe VM', connected: true }
        ]
      }
    })

    await expect(listRuntimeOwnedSshAiVaultTargets('/user-data', 'hub-runtime')).resolves.toEqual([
      {
        environmentId: 'hub-runtime',
        targetId: 'hub-owned-host',
        executionHostId: 'ssh:hub-owned-host',
        connected: true
      },
      {
        environmentId: 'hub-runtime',
        targetId: 'offline-host',
        executionHostId: 'ssh:offline-host',
        connected: false
      }
    ])
  })

  it('skips malformed target rows from a paired runtime', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: { targets: [null, 42, { id: '\ud800' }, { id: 'hub-owned-host', connected: true }] }
    })

    await expect(listRuntimeOwnedSshAiVaultTargets('/user-data', 'hub-runtime')).resolves.toEqual([
      {
        environmentId: 'hub-runtime',
        targetId: 'hub-owned-host',
        executionHostId: 'ssh:hub-owned-host',
        connected: true
      }
    ])
  })

  it('finds which paired runtime registered an SSH target', async () => {
    await expect(findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')).resolves.toEqual({
      environmentId: 'hub-runtime',
      targetId: 'hub-owned-host',
      executionHostId: 'ssh:hub-owned-host'
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'hub-runtime',
      'ssh.listTargetSummaries',
      undefined,
      undefined
    )
  })

  it('reuses a bounded owner lookup for repeated title batches', async () => {
    await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(1)
  })

  it('caches a missing owner instead of repeating runtime inventory fanout', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({ ok: true, result: { targets: [] } })

    await findRuntimeOwningSshAiVaultHost('/user-data', 'disconnected-local-host')
    await findRuntimeOwningSshAiVaultHost('/user-data', 'disconnected-local-host')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(1)
  })

  it('does not cache a missing owner when runtime inventory failed', async () => {
    mocks.callRuntimeEnvironment
      .mockRejectedValueOnce(new Error('runtime offline'))
      .mockResolvedValueOnce({
        ok: true,
        result: { targets: [{ id: 'hub-owned-host' }] }
      })

    await expect(
      findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    ).resolves.toBeNull()
    await expect(
      findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    ).resolves.toMatchObject({ environmentId: 'hub-runtime' })

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent owner lookups', async () => {
    let resolveInventory!: (value: { ok: true; result: { targets: { id: string }[] } }) => void
    mocks.callRuntimeEnvironment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInventory = resolve
      })
    )

    const first = findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    const second = findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(1)
    resolveInventory({ ok: true, result: { targets: [{ id: 'hub-owned-host' }] } })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ environmentId: 'hub-runtime' }),
      expect.objectContaining({ environmentId: 'hub-runtime' })
    ])
  })

  it('expires cached owner lookups after one minute', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-14T00:00:00.000Z') })
    try {
      await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
      await vi.advanceTimersByTimeAsync(60_000)
      await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')

      expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not share owner lookups across runtime inventories', async () => {
    await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    mocks.listEnvironments.mockReturnValue([{ id: 'other-runtime' }])
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: { targets: [] } })

    await expect(
      findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    ).resolves.toBeNull()
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('does not share owner lookups across a re-pair of the same environment id', async () => {
    mocks.listEnvironments.mockReturnValue([
      { id: 'hub-runtime', createdAt: 1, pairingRevision: 1, runtimeId: 'runtime-a' }
    ])
    await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')
    mocks.listEnvironments.mockReturnValue([
      { id: 'hub-runtime', createdAt: 1, pairingRevision: 2, runtimeId: 'runtime-b' }
    ])

    await findRuntimeOwningSshAiVaultHost('/user-data', 'hub-owned-host')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('does not treat recipe-VM targets as runtime-owned SSH history hosts', async () => {
    await expect(findRuntimeOwningSshAiVaultHost('/user-data', 'runtime-ssh-recipe')).resolves.toBe(
      null
    )
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('asks the owning runtime to scan a named SSH host and keeps the SSH stamp', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: true,
      result: result([session('local', 'ssh-session')])
    })

    const scanned = await scanRuntimeOwnedSshAiVaultSessions(
      '/user-data',
      'hub-runtime',
      'hub-owned-host',
      { limit: 25, force: true }
    )

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'hub-runtime',
      'aiVault.listSessions',
      {
        limit: 25,
        force: true,
        executionHostId: 'ssh:hub-owned-host'
      },
      undefined
    )
    expect(scanned.sessions).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:hub-owned-host',
        sessionId: 'ssh-session'
      })
    ])
  })

  it('turns a runtime transport throw into an SSH-host issue', async () => {
    mocks.callRuntimeEnvironment.mockRejectedValueOnce(new Error('runtime connect timed out'))

    const scanned = await scanRuntimeOwnedSshAiVaultSessions(
      '/user-data',
      'hub-runtime',
      'hub-owned-host',
      {}
    )

    expect(scanned.sessions).toEqual([])
    expect(scanned.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:hub-owned-host',
        message: 'runtime connect timed out'
      })
    ])
  })

  it('turns an old-runtime host-id rejection into an SSH-host issue', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Invalid runtime execution host id' }
    })

    const scanned = await scanRuntimeOwnedSshAiVaultSessions(
      '/user-data',
      'hub-runtime',
      'hub-owned-host',
      {}
    )

    expect(scanned.sessions).toEqual([])
    expect(scanned.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:hub-owned-host',
        path: 'hub-owned-host',
        message: expect.stringContaining('cannot scan Agent Session History on its SSH hosts')
      })
    ])
  })
})

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-08-12T00:00:00.000Z' }
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
    updatedAt: '2026-08-12T03:00:00.000Z',
    modifiedAt: '2026-08-12T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
