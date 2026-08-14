import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessionsInWorker: vi.fn(),
  resolveAiVaultSessionTitlesInWorker: vi.fn(),
  scanRemoteAiVaultSessions: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  getActiveSshAiVaultHostInfo: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(),
  requestActiveSshAiVaultSessionList: vi.fn(),
  requestActiveSshAiVaultSessionTitles: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle }
}))

vi.mock('../ai-vault/session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker: mocks.scanAiVaultSessionsInWorker,
  resolveAiVaultSessionTitlesInWorker: mocks.resolveAiVaultSessionTitlesInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
}))

vi.mock('../ai-vault/remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: mocks.scanRemoteAiVaultSessions
}))

vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn().mockResolvedValue([])
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

vi.mock('./ssh', () => ({
  getActiveSshAiVaultHostInfo: mocks.getActiveSshAiVaultHostInfo,
  getActiveSshAiVaultHostInfos: mocks.getActiveSshAiVaultHostInfos,
  requestActiveSshAiVaultSessionList: mocks.requestActiveSshAiVaultSessionList,
  requestActiveSshAiVaultSessionTitles: mocks.requestActiveSshAiVaultSessionTitles
}))

const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const { scanAiVaultSessionsByHostScope } = await import('./ai-vault-host-scope-scan')
const { scanSshAiVaultSessionsByOwner } = await import('./ai-vault-runtime-owned-ssh')

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanAiVaultSessionsInWorker.mockResolvedValue(result([]))
  mocks.resolveAiVaultSessionTitlesInWorker.mockResolvedValue({ titles: [] })
  mocks.scanRemoteAiVaultSessions.mockResolvedValue(result([]))
  mocks.getSshFilesystemProvider.mockReturnValue({} as IFilesystemProvider)
  mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(null)
  mocks.requestActiveSshAiVaultSessionTitles.mockResolvedValue(null)
  mocks.getActiveSshAiVaultHostInfo.mockReturnValue(null)
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([])
})

describe('runtime-owned SSH AI Vault routing', () => {
  it('does not start a named runtime-owned SSH hop after owner lookup is cancelled', async () => {
    let resolveOwner!: (owner: {
      environmentId: string
      targetId: string
      executionHostId: 'ssh:hub-owned-host'
    }) => void
    const findOwner = vi.fn(
      () =>
        new Promise<{
          environmentId: string
          targetId: string
          executionHostId: 'ssh:hub-owned-host'
        }>((resolve) => {
          resolveOwner = resolve
        })
    )
    const scanOwned = vi.fn().mockResolvedValue(result([]))
    const controller = new AbortController()
    const pending = scanSshAiVaultSessionsByOwner({
      targetId: 'hub-owned-host',
      signal: controller.signal,
      ownedTimeoutMs: 20_000,
      findOwner,
      scanOwned
    })
    await vi.waitFor(() => expect(findOwner).toHaveBeenCalledTimes(1))

    controller.abort()
    resolveOwner({
      environmentId: 'hub-runtime',
      targetId: 'hub-owned-host',
      executionHostId: 'ssh:hub-owned-host'
    })

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(scanOwned).not.toHaveBeenCalled()
  })

  it('does not start all-host runtime-owned SSH legs after cancellation', async () => {
    let resolveTargets!: (
      targets: readonly {
        environmentId: string
        targetId: string
        executionHostId: 'ssh:hub-owned-host'
        connected: true
      }[]
    ) => void
    const listRuntimeOwnedSshAiVaultTargets = vi.fn(
      () =>
        new Promise<
          readonly {
            environmentId: string
            targetId: string
            executionHostId: 'ssh:hub-owned-host'
            connected: true
          }[]
        >((resolve) => {
          resolveTargets = resolve
        })
    )
    const scanOwned = vi.fn().mockResolvedValue(result([]))
    const controller = new AbortController()
    const pending = scanAiVaultSessionsByHostScope(
      { executionHostScope: 'all' },
      'all',
      controller.signal,
      'all-hosts',
      {
        getActiveRuntimeAiVaultHostInfos: () => [
          { environmentId: 'hub-runtime', executionHostId: 'runtime:hub-runtime' }
        ],
        listRuntimeOwnedSshAiVaultTargets,
        scanRuntimeOwnedSshAiVaultSessions: scanOwned,
        scanLocal: async () => result([])
      }
    )
    await vi.waitFor(() => expect(listRuntimeOwnedSshAiVaultTargets).toHaveBeenCalledTimes(1))

    controller.abort()
    resolveTargets([
      {
        environmentId: 'hub-runtime',
        targetId: 'hub-owned-host',
        executionHostId: 'ssh:hub-owned-host',
        connected: true
      }
    ])

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(scanOwned).not.toHaveBeenCalled()
  })

  it('routes an SSH host the local process does not own through its paired runtime', async () => {
    const scanRuntimeOwnedSshAiVaultSessions = vi
      .fn()
      .mockResolvedValue(result([session('ssh:hub-owned-host', 'hub-ssh-session')]))
    registerAiVaultHandlers({
      findRuntimeOwningSshAiVaultHost: async () => ({
        environmentId: 'hub-runtime',
        targetId: 'hub-owned-host',
        executionHostId: 'ssh:hub-owned-host'
      }),
      scanRuntimeOwnedSshAiVaultSessions
    })

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:hub-owned-host'
    })

    expect(scanRuntimeOwnedSshAiVaultSessions).toHaveBeenCalledWith(
      'hub-runtime',
      'hub-owned-host',
      { executionHostScope: 'ssh:hub-owned-host' },
      { timeoutMs: 20_000 }
    )
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
    expect(scanned.sessions).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:hub-owned-host',
        sessionId: 'hub-ssh-session'
      })
    ])
  })

  it('scans runtime-owned SSH hosts as their own all-hosts legs', async () => {
    const listRuntimeOwnedSshAiVaultTargets = vi.fn().mockResolvedValue([
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
    const scanRuntimeOwnedSshAiVaultSessions = vi
      .fn()
      .mockResolvedValue(result([session('ssh:hub-owned-host', 'hub-ssh-session')]))
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [
        { environmentId: 'hub-runtime', executionHostId: 'runtime:hub-runtime' }
      ],
      listRuntimeOwnedSshAiVaultTargets,
      scanRuntimeOwnedSshAiVaultSessions
    })

    const scanned = await _internals.listAiVaultSessions({ executionHostScope: 'all' })

    expect(listRuntimeOwnedSshAiVaultTargets).toHaveBeenCalledWith('hub-runtime')
    expect(scanRuntimeOwnedSshAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(scanRuntimeOwnedSshAiVaultSessions).toHaveBeenCalledWith(
      'hub-runtime',
      'hub-owned-host',
      { executionHostScope: 'all' },
      { timeoutMs: 20_000 }
    )
    expect(scanned.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionHostId: 'ssh:hub-owned-host',
          sessionId: 'hub-ssh-session'
        })
      ])
    )
  })

  it('does not send recipe-VM SSH targets through a paired runtime', async () => {
    const findRuntimeOwningSshAiVaultHost = vi.fn()
    registerAiVaultHandlers({ findRuntimeOwningSshAiVaultHost })

    const scanned = await _internals.listAiVaultSessions({
      executionHostScope: 'ssh:runtime-ssh-recipe'
    })

    expect(findRuntimeOwningSshAiVaultHost).not.toHaveBeenCalled()
    expect(scanned.sessions).toEqual([])
    expect(scanned.issues).toMatchObject([
      {
        executionHostId: 'ssh:runtime-ssh-recipe',
        agent: 'codex',
        path: 'runtime-ssh-recipe'
      }
    ])
  })

  it('resolves SSH titles through the owning runtime when this process has no session', async () => {
    mocks.requestActiveSshAiVaultSessionTitles.mockRejectedValue(
      new Error('SSH relay is not ready')
    )
    const titles = {
      titles: [{ agent: 'codex' as const, sessionId: 'session-1', title: 'Exact title' }]
    }
    const requests = [
      { agent: 'codex' as const, sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl' }
    ]
    const resolveRuntimeOwnedSshAiVaultSessionTitles = vi.fn().mockResolvedValue(titles)
    registerAiVaultHandlers({
      findRuntimeOwningSshAiVaultHost: async () => ({
        environmentId: 'hub-runtime',
        targetId: 'hub-owned-host',
        executionHostId: 'ssh:hub-owned-host'
      }),
      resolveRuntimeOwnedSshAiVaultSessionTitles
    })

    await expect(
      _internals.resolveAiVaultSessionTitles({
        executionHostScope: 'ssh:hub-owned-host',
        requests
      })
    ).resolves.toEqual(titles)

    expect(resolveRuntimeOwnedSshAiVaultSessionTitles).toHaveBeenCalledWith(
      'hub-runtime',
      'hub-owned-host',
      {
        executionHostScope: 'ssh:hub-owned-host',
        requests
      }
    )
  })

  it('does not resolve titles through another runtime for a locally owned SSH target', async () => {
    mocks.requestActiveSshAiVaultSessionTitles.mockResolvedValue(null)
    mocks.getActiveSshAiVaultHostInfo.mockReturnValue({})
    const findRuntimeOwningSshAiVaultHost = vi.fn()
    const resolveRuntimeOwnedSshAiVaultSessionTitles = vi.fn()
    registerAiVaultHandlers({
      findRuntimeOwningSshAiVaultHost,
      resolveRuntimeOwnedSshAiVaultSessionTitles
    })

    await expect(
      _internals.resolveAiVaultSessionTitles({
        executionHostScope: 'ssh:dev-box',
        requests: [{ agent: 'codex', sessionId: 'session-1' }]
      })
    ).resolves.toEqual({ titles: [] })

    expect(findRuntimeOwningSshAiVaultHost).not.toHaveBeenCalled()
    expect(resolveRuntimeOwnedSshAiVaultSessionTitles).not.toHaveBeenCalled()
  })
})

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: new Date().toISOString() }
}

function session(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId,
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: new Date().toISOString(),
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
