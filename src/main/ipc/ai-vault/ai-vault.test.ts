import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import type * as CachedSessionListModule from '../../ai-vault/cached-session-list'
import type * as SessionParseCacheModule from '../../ai-vault/parse-cache/session-parse-cache-store'

const mocks = vi.hoisted(() => ({
  scanLocalSessions: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn(),
  listSubagentsInService: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn(),
  ipcHandle: vi.fn(),
  trashItem: vi.fn(),
  deleteAiVaultSessionFile: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  invalidateSessionParseCacheEntry: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle },
  shell: { trashItem: mocks.trashItem }
}))

vi.mock('../../ai-vault/scan-service/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanLocalSessions,
  resolveAiVaultSessionTitlesInService: mocks.resolveAiVaultSessionTitlesInService,
  listAiVaultSubagentSessionsInService: mocks.listSubagentsInService
}))

vi.mock('../../ai-vault/session-delete', () => ({
  deleteAiVaultSessionFile: mocks.deleteAiVaultSessionFile
}))

// Mock only invalidation so routing and cache tests retain the real list implementation.
vi.mock('../../ai-vault/cached-session-list', async (importOriginal) => {
  const actual = await importOriginal<typeof CachedSessionListModule>()
  return {
    ...actual,
    invalidateAiVaultSessionListCache: mocks.invalidateAiVaultSessionListCache
  }
})

vi.mock('../../ai-vault/parse-cache/session-parse-cache-store', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionParseCacheModule>()
  return {
    ...actual,
    invalidateSessionParseCacheEntry: mocks.invalidateSessionParseCacheEntry
  }
})

vi.mock('../../wsl/discovery/distro-catalog', () => ({
  listRunningWslDistrosAsync: vi.fn().mockResolvedValue([]),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
}))

const { resolveOmpSessionsDir } = await import('../../ai-vault/scanners/omp/omp-session-root')
const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const { deleteAiVaultSession: deleteAiVaultSessionWithDeps } = await import('./ai-vault-delete')
await import('../../ai-vault/host-session-delete')

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanLocalSessions.mockResolvedValue(result([session('local', 'local-session')]))
  mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  mocks.listSubagentsInService.mockResolvedValue({ sessions: [], issues: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(
    result([session('runtime:remote-server', 'runtime-session')])
  )
})

describe('prepareSessionResume IPC', () => {
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

  it("routes a server-hosted session to its owning host and drops that host's cached list", async () => {
    const deleteRuntimeAiVaultSession = vi.fn().mockResolvedValue({ outcome: 'deleted' })
    const invalidateMultiHostListCache = vi.fn()

    const result = await deleteAiVaultSessionWithDeps(
      { ...args, executionHostId: 'runtime:gpu%20box' },
      { invalidateMultiHostListCache, deleteRuntimeSession: deleteRuntimeAiVaultSession }
    )

    expect(result).toEqual({ outcome: 'deleted' })
    expect(deleteRuntimeAiVaultSession).toHaveBeenCalledWith(
      'gpu box',
      expect.objectContaining({ agent: 'gemini', filePath: args.filePath })
    )
    expect(invalidateMultiHostListCache).toHaveBeenCalledTimes(1)
    // This computer never touches a path that belongs to another host.
    expect(mocks.deleteAiVaultSessionFile).not.toHaveBeenCalled()
  })

  it('never routes the unresolved-owner sentinel to a host', async () => {
    const deleteRuntimeAiVaultSession = vi.fn()
    mocks.deleteAiVaultSessionFile.mockResolvedValue({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'non-local-host'
    })

    await deleteAiVaultSessionWithDeps(
      { ...args, executionHostId: 'runtime:unresolved-owner' },
      {
        invalidateMultiHostListCache: vi.fn(),
        deleteRuntimeSession: deleteRuntimeAiVaultSession
      }
    )

    expect(deleteRuntimeAiVaultSession).not.toHaveBeenCalled()
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
