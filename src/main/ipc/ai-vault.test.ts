import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { IFilesystemProvider } from '../providers/types'
import type * as CachedSessionListModule from '../ai-vault/cached-session-list'
import type * as SessionParseCacheModule from '../ai-vault/session-scanner-parse-cache'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const mocks = vi.hoisted(() => ({
  scanLocalSessions: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn(),
  scanRemoteAiVaultSessions: vi.fn(),
  listSubagentsInService: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  getActiveSshAiVaultHostInfo: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(),
  requestActiveSshAiVaultSessionList: vi.fn(),
  requestActiveSshAiVaultSessionTitles: vi.fn(),
  ipcHandle: vi.fn(),
  deleteAiVaultSessionFile: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  invalidateSessionParseCacheEntry: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle }
}))

vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanLocalSessions,
  resolveAiVaultSessionTitlesInService: mocks.resolveAiVaultSessionTitlesInService,
  listAiVaultSubagentSessionsInService: mocks.listSubagentsInService
}))

vi.mock('../ai-vault/remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: mocks.scanRemoteAiVaultSessions
}))

vi.mock('../ai-vault/session-delete', () => ({
  deleteAiVaultSessionFile: mocks.deleteAiVaultSessionFile
}))

// Why: only the invalidation seam is replaced — everything else (cachedList,
// listAiVaultSessions, ...) keeps its real implementation so the existing
// host-routing/caching tests below stay exercising real behavior.
vi.mock('../ai-vault/cached-session-list', async (importOriginal) => {
  const actual = await importOriginal<typeof CachedSessionListModule>()
  return {
    ...actual,
    invalidateAiVaultSessionListCache: mocks.invalidateAiVaultSessionListCache
  }
})

vi.mock('../ai-vault/session-scanner-parse-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionParseCacheModule>()
  return {
    ...actual,
    invalidateSessionParseCacheEntry: mocks.invalidateSessionParseCacheEntry
  }
})

vi.mock('../wsl', () => ({
  listRunningWslDistrosAsync: vi.fn().mockResolvedValue([]),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
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

const { resolveOmpSessionsDir } = await import('../ai-vault/omp-session-root')
const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const { deleteAiVaultSession: deleteAiVaultSessionWithDeps } = await import('./ai-vault-delete')

const provider = {} as IFilesystemProvider

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanLocalSessions.mockResolvedValue(result([session('local', 'local-session')]))
  mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  mocks.scanRemoteAiVaultSessions.mockResolvedValue(
    result([session('ssh:dev-box', 'remote-session')])
  )
  mocks.listSubagentsInService.mockResolvedValue({ sessions: [], issues: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(
    result([session('runtime:remote-server', 'runtime-session')])
  )
  mocks.getSshFilesystemProvider.mockReturnValue(provider)
  mocks.requestActiveSshAiVaultSessionList.mockResolvedValue(null)
  mocks.requestActiveSshAiVaultSessionTitles.mockResolvedValue(null)
  mocks.getActiveSshAiVaultHostInfo.mockReturnValue(hostInfo('dev-box'))
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([hostInfo('dev-box')])
})

describe('listAiVaultSessions host routing', () => {
  it('routes local scope to the local scanner', async () => {
    await _internals.listAiVaultSessions({
      executionHostScope: 'local',
      scopePaths: ['/repo'],
      includeAntigravityIdeSessions: true
    })

    expect(mocks.scanLocalSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        scopePaths: ['/repo'],
        includeAntigravityIdeSessions: true,
        executionHostId: 'local'
      }),
      expect.any(AbortSignal)
    )
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
  })

  it('keeps direct runtime host scans on the normal runtime timeout', async () => {
    registerAiVaultHandlers({
      getActiveRuntimeAiVaultHostInfos: () => [],
      scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
    })

    await _internals.listAiVaultSessions({
      executionHostScope: 'runtime:remote-server',
      force: true
    })

    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledWith(
      'remote-server',
      {
        executionHostScope: 'runtime:remote-server',
        force: true
      },
      {}
    )
  })
})

describe('resolveAiVaultSessionTitles host routing', () => {
  const requests = [
    { agent: 'codex' as const, sessionId: 'session-1', transcriptPath: '/tmp/session.jsonl' }
  ]
  const titles = {
    titles: [{ agent: 'codex' as const, sessionId: 'session-1', title: 'Exact title' }]
  }

  it('routes local identities to the scanner service without a broad scan', async () => {
    mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue(titles)

    await expect(
      _internals.resolveAiVaultSessionTitles({ executionHostScope: 'local', requests })
    ).resolves.toEqual(titles)

    expect(mocks.resolveAiVaultSessionTitlesInService).toHaveBeenCalledWith(requests, undefined)
    expect(mocks.scanLocalSessions).not.toHaveBeenCalled()
  })

  it('routes runtime identities to the paired runtime host', async () => {
    const resolveRuntimeAiVaultSessionTitles = vi.fn().mockResolvedValue(titles)
    registerAiVaultHandlers({ resolveRuntimeAiVaultSessionTitles })

    await expect(
      _internals.resolveAiVaultSessionTitles({
        executionHostScope: 'runtime:remote-server',
        requests
      })
    ).resolves.toEqual(titles)

    expect(resolveRuntimeAiVaultSessionTitles).toHaveBeenCalledWith('remote-server', {
      executionHostScope: 'runtime:remote-server',
      requests
    })
    expect(mocks.scanRuntimeAiVaultSessions).not.toHaveBeenCalled()
  })

  it('degrades unsupported hosts without falling back to a broad scan', async () => {
    mocks.requestActiveSshAiVaultSessionTitles.mockRejectedValue(
      new Error('Method not found: aiVault.resolveSessionTitles')
    )

    await expect(
      _internals.resolveAiVaultSessionTitles({
        executionHostScope: 'ssh:dev-box',
        requests
      })
    ).resolves.toEqual({ titles: [] })

    expect(mocks.scanLocalSessions).not.toHaveBeenCalled()
    expect(mocks.scanRemoteAiVaultSessions).not.toHaveBeenCalled()
  })
})

describe('prepareSessionResume IPC', () => {
  it('awaits the host-local targeted resume preparation', async () => {
    const prepareSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    registerAiVaultHandlers({ prepareSessionResume })
    const registration = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'aiVault:prepareSessionResume'
    )
    const handler = registration?.[1] as
      | ((_event: unknown, args: unknown) => Promise<unknown>)
      | undefined
    const args = {
      agent: 'codex',
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'local'
    }

    await expect(handler?.({}, args)).resolves.toEqual({ useRealCodexHome: true })
    expect(prepareSessionResume).toHaveBeenCalledWith(args)
  })

  it('prepares saved-runtime sessions on the transcript-owning runtime', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn().mockResolvedValue({ useRealCodexHome: true })
    registerAiVaultHandlers({ prepareSessionResume, prepareRuntimeSessionResume })
    const args = {
      agent: 'codex' as const,
      filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
      codexHome: '/managed',
      executionHostId: 'runtime:env-123' as const
    }

    await expect(getPrepareSessionResumeHandler()({}, args)).resolves.toEqual({
      useRealCodexHome: true
    })
    expect(prepareRuntimeSessionResume).toHaveBeenCalledWith('env-123', args)
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })

  it('preserves SSH session homes without reading their paths locally', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn()
    registerAiVaultHandlers({ prepareSessionResume, prepareRuntimeSessionResume })

    await expect(
      getPrepareSessionResumeHandler()(
        {},
        {
          agent: 'codex',
          filePath: '/managed/sessions/2026/07/20/rollout-a.jsonl',
          codexHome: '/managed',
          executionHostId: 'ssh:dev-box'
        }
      )
    ).resolves.toEqual({ useRealCodexHome: false })
    expect(prepareSessionResume).not.toHaveBeenCalled()
    expect(prepareRuntimeSessionResume).not.toHaveBeenCalled()
  })
})

function getPrepareSessionResumeHandler(): (
  event: unknown,
  args: unknown
) => Promise<{ useRealCodexHome: boolean }> {
  const registration = mocks.ipcHandle.mock.calls.find(
    ([channel]) => channel === 'aiVault:prepareSessionResume'
  )
  if (!registration) {
    throw new Error('aiVault:prepareSessionResume was not registered')
  }
  return registration[1]
}

describe('listAiVaultSubagentSessions gating', () => {
  const claudeRoot = join(homedir(), '.claude', 'projects')

  it('lists subagents for a local Claude session inside the projects root', async () => {
    const parentFilePath = join(claudeRoot, 'proj', 'sess.jsonl')

    await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath,
      executionHostId: 'local'
    })

    expect(mocks.listSubagentsInService).toHaveBeenCalledWith({ agent: 'claude', parentFilePath })
  })

  it('returns empty for a remote Claude session without reading the filesystem', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: join(claudeRoot, 'proj', 'sess.jsonl'),
      executionHostId: 'ssh:dev-box'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('rejects a path outside the Claude projects root', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: '/etc/secrets/subagents',
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('rejects a dot-segment traversal out of the Claude projects root', async () => {
    // Built with sep (not join) so the `..` segments survive into the arg.
    const traversal = [claudeRoot, '..', '..', '..', 'etc', 'passwd.jsonl'].join(sep)

    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: traversal,
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('resolves empty for malformed IPC payloads instead of throwing', async () => {
    const missing = await _internals.listAiVaultSubagentSessions(undefined)
    const badPath = await _internals.listAiVaultSubagentSessions({
      agent: 'claude',
      parentFilePath: 42 as unknown as string,
      executionHostId: 'local'
    })

    expect(missing).toEqual({ sessions: [], issues: [] })
    expect(badPath).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('returns empty for an agent with no sibling subagent layout', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'codex',
      parentFilePath: join(claudeRoot, 'proj', 'sess.jsonl'),
      executionHostId: 'local'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('lists subagents for a local OMP session inside the sessions root', async () => {
    const parentFilePath = join(
      resolveOmpSessionsDir(),
      'home-app-85dfa2f0',
      '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000.jsonl'
    )

    await _internals.listAiVaultSubagentSessions({
      agent: 'omp',
      parentFilePath,
      executionHostId: 'local'
    })

    expect(mocks.listSubagentsInService).toHaveBeenCalledWith({ agent: 'omp', parentFilePath })
  })

  it('returns empty for a remote OMP session without reading the filesystem', async () => {
    const result = await _internals.listAiVaultSubagentSessions({
      agent: 'omp',
      parentFilePath: join(resolveOmpSessionsDir(), 'slug', 'sess.jsonl'),
      executionHostId: 'ssh:dev-box'
    })

    expect(result).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })

  it('rejects an OMP path that only sits inside another agent root', async () => {
    // Each agent's allowlist is its own root: a Claude path must not be
    // readable through the OMP branch (or vice versa).
    const crossAgent = await _internals.listAiVaultSubagentSessions({
      agent: 'omp',
      parentFilePath: join(claudeRoot, 'proj', 'sess.jsonl'),
      executionHostId: 'local'
    })
    const traversal = await _internals.listAiVaultSubagentSessions({
      agent: 'omp',
      // Built with sep (not join) so the `..` segments survive into the arg.
      parentFilePath: [resolveOmpSessionsDir(), '..', '..', '..', 'etc', 'passwd.jsonl'].join(sep),
      executionHostId: 'local'
    })

    expect(crossAgent).toEqual({ sessions: [], issues: [] })
    expect(traversal).toEqual({ sessions: [], issues: [] })
    expect(mocks.listSubagentsInService).not.toHaveBeenCalled()
  })
})

describe('deleteAiVaultSession', () => {
  const args = {
    agent: 'gemini' as const,
    sessionId: 'session-1',
    filePath: '/home/ada/.gemini/tmp/sess.json',
    executionHostId: 'local' as const
  }

  it('invalidates every AI Vault cache after a real delete', async () => {
    const invalidateMultiHostListCache = vi.fn()
    const invalidateBackgroundCache = vi.fn().mockResolvedValue(undefined)
    mocks.deleteAiVaultSessionFile.mockResolvedValue({ outcome: 'deleted' })

    const result = await deleteAiVaultSessionWithDeps(args, {
      invalidateMultiHostListCache,
      invalidateBackgroundCache
    })

    expect(result).toEqual({ outcome: 'deleted' })
    expect(mocks.deleteAiVaultSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'gemini',
        sessionId: args.sessionId,
        filePath: args.filePath,
        executionHostId: 'local'
      })
    )
    expect(invalidateMultiHostListCache).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateAiVaultSessionListCache).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateSessionParseCacheEntry).toHaveBeenCalledWith(args.filePath)
    expect(invalidateBackgroundCache).toHaveBeenCalledWith([args.filePath])
  })

  it('does not invalidate any cache when the executor rejects (e.g. non-local host)', async () => {
    mocks.deleteAiVaultSessionFile.mockResolvedValue({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'non-local-host'
    })

    const result = await _internals.deleteAiVaultSession({
      ...args,
      executionHostId: 'ssh:dev-box'
    })

    expect(result).toEqual({ outcome: 'rejected', agent: 'gemini', reason: 'non-local-host' })
    expect(mocks.invalidateAiVaultSessionListCache).not.toHaveBeenCalled()
    expect(mocks.invalidateSessionParseCacheEntry).not.toHaveBeenCalled()
  })

  it('does not invalidate any cache when the executor fails', async () => {
    mocks.deleteAiVaultSessionFile.mockResolvedValue({
      outcome: 'failed',
      agent: 'gemini',
      error: 'EPERM'
    })

    await _internals.deleteAiVaultSession(args)

    expect(mocks.invalidateAiVaultSessionListCache).not.toHaveBeenCalled()
    expect(mocks.invalidateSessionParseCacheEntry).not.toHaveBeenCalled()
  })

  it('resolves a malformed payload to a rejection instead of throwing', async () => {
    mocks.deleteAiVaultSessionFile.mockResolvedValue({
      outcome: 'rejected',
      agent: undefined,
      reason: 'invalid-path'
    })

    await expect(_internals.deleteAiVaultSession(undefined)).resolves.toEqual({
      outcome: 'rejected',
      agent: undefined,
      reason: 'invalid-path'
    })
    expect(mocks.deleteAiVaultSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '' })
    )
    expect(mocks.invalidateAiVaultSessionListCache).not.toHaveBeenCalled()
  })

  it('registers the aiVault:deleteSession IPC channel', () => {
    registerAiVaultHandlers()

    expect(mocks.ipcHandle).toHaveBeenCalledWith('aiVault:deleteSession', expect.any(Function))
  })
})

function hostInfo(targetId: string) {
  return {
    targetId,
    executionHostId: `ssh:${targetId}` as const,
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64')
  }
}

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
    updatedAt:
      sessionId === 'runtime-session'
        ? '2026-07-04T03:00:00.000Z'
        : sessionId === 'remote-session'
          ? '2026-07-04T02:00:00.000Z'
          : '2026-07-04T01:00:00.000Z',
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
