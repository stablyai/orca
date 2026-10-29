import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultLocalScanKey } from '../../shared/ai-vault-local-scan-key'
import {
  localAiVaultScanProgress,
  resetLocalAiVaultScanProgressForTests,
  type LocalAiVaultScanProgressHandle
} from './ai-vault-local-scan-progress'

const {
  filterPathsToRunningWslDistrosAsync,
  getCachedWslDistros,
  hasCachedWslDistros,
  listRunningWslHomeDirsAsync,
  scanAiVaultSessionsInService
} = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths]),
  getCachedWslDistros: vi.fn((): string[] | null => null),
  hasCachedWslDistros: vi.fn(() => false),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('./session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))
vi.mock('../wsl', () => ({
  getCachedWslDistros,
  hasCachedWslDistros,
  listRunningWslHomeDirsAsync
}))
vi.mock('../wsl-running-path-filter', () => ({ filterPathsToRunningWslDistrosAsync }))

import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'

let platform: NodeJS.Platform

function scanResult(scannedAt: string): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt }
}

function deferredScan(): { resolve: (value: AiVaultListResult) => void } {
  let resolveFn: (value: AiVaultListResult) => void = () => {}
  const pending = new Promise<AiVaultListResult>((resolve) => {
    resolveFn = resolve
  })
  scanAiVaultSessionsInService.mockImplementationOnce(
    async (_options, _signal, progress?: LocalAiVaultScanProgressHandle) => {
      const value = await pending
      progress?.finish(null)
      return value
    }
  )
  return { resolve: resolveFn }
}

describe('invalidateAiVaultSessionListCache generation guard', () => {
  beforeEach(() => {
    platform = 'win32'
    vi.spyOn(process, 'platform', 'get').mockImplementation(() => platform)
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
    filterPathsToRunningWslDistrosAsync.mockClear()
    getCachedWslDistros.mockReset().mockReturnValue(null)
    hasCachedWslDistros.mockReset().mockReturnValue(false)
    listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
    scanAiVaultSessionsInService.mockReset()
  })
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
    vi.restoreAllMocks()
  })

  it('does not let a scan that started before an invalidation repopulate the cache', async () => {
    const scanA = deferredScan()
    const inFlight = listAiVaultSessions()

    invalidateAiVaultSessionListCache()

    scanA.resolve(scanResult('scan-A'))
    await inFlight

    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('scan-B'))
    const next = await listAiVaultSessions()

    expect(next.scannedAt).toBe('scan-B')
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
  })

  it.each(['old-first', 'new-first'])(
    'keeps post-invalidation scans separate with %s completion',
    async (order) => {
      const request = { scopePaths: ['/project'] }
      const scanKey = aiVaultLocalScanKey(request)
      const scanA = deferredScan()
      const beforeDelete = listAiVaultSessions(request)
      await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1))

      invalidateAiVaultSessionListCache()
      const scanB = deferredScan()
      const afterDelete = listAiVaultSessions(request)
      const sameGeneration = listAiVaultSessions(request)
      try {
        await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2))
        if (order === 'old-first') {
          scanA.resolve(scanResult('scan-A'))
          await beforeDelete
        }
        scanB.resolve(scanResult('scan-B'))
        const fresh = await afterDelete
        expect(fresh.scannedAt).toBe('scan-B')
        expect(fresh.scanId).toEqual(expect.any(String))
        expect((await sameGeneration).scanId).toBe(fresh.scanId)

        scanA.resolve(scanResult('scan-A'))
        const old = await beforeDelete
        expect(old.scannedAt).toBe('scan-A')
        expect(old.scanId).not.toBe(fresh.scanId)
        const cached = await listAiVaultSessions(request)
        expect(cached.scannedAt).toBe('scan-B')
        expect(cached.scanId).toBe(fresh.scanId)
        expect(localAiVaultScanProgress(scanKey)).toMatchObject({
          scanId: fresh.scanId,
          stage: 'finished'
        })
        expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
      } finally {
        scanA.resolve(scanResult('scan-A'))
        scanB.resolve(scanResult('scan-B'))
        await Promise.allSettled([beforeDelete, afterDelete, sameGeneration])
      }
    }
  )

  it('caches normally when no invalidation interrupts the scan', async () => {
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('scan-A'))
    const request = { limit: 1000, scopePaths: ['/project'] }
    const first = await listAiVaultSessions(request)

    const cached = await listAiVaultSessions(request)

    expect(cached.scannedAt).toBe('scan-A')
    expect(cached.scanId).toBe(first.scanId)
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('skips running-distro discovery once a probe has reported no installed WSL distro', async () => {
    hasCachedWslDistros.mockReturnValue(true)
    getCachedWslDistros.mockReturnValue([])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([])
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })

  it('still discovers running distros before any distro probe has succeeded', async () => {
    hasCachedWslDistros.mockReturnValue(false)
    listRunningWslHomeDirsAsync.mockResolvedValue(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('skips WSL home discovery off Windows', async () => {
    platform = 'linux'

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([])
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })
})

describe('listAiVaultSessions symlinked scope', () => {
  let root: string
  beforeEach(async () => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInService.mockReset()
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-cached-scope-')))
  })
  afterEach(async () => {
    resetAiVaultSessionListCacheForTests()
    await rm(root, { recursive: true, force: true })
  })

  it('scans the real path too and keeps real-path sessions in a symlinked workspace', async () => {
    const realRepo = join(root, 'data', 'api')
    const linkedRepo = join(root, 'work-api')
    await mkdir(realRepo, { recursive: true })
    await symlink(realRepo, linkedRepo, 'junction')
    const recorded = {
      id: 'codex:s1',
      executionHostId: 'local',
      agent: 'codex',
      sessionId: 's1',
      title: 's1',
      cwd: realRepo,
      branch: null,
      model: null,
      filePath: join(root, 's1.jsonl'),
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-10-20T00:00:00.000Z',
      messageCount: 1,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: 's1',
      subagent: null
    } satisfies AiVaultSession
    const outOfScope = (id: string): AiVaultSession => ({
      ...recorded,
      id: `codex:${id}`,
      sessionId: id,
      cwd: join(root, 'elsewhere'),
      modifiedAt: '2026-10-21T00:00:00.000Z'
    })
    scanAiVaultSessionsInService.mockResolvedValueOnce({
      ...scanResult('scan-A'),
      sessions: [outOfScope('newer-1'), outOfScope('newer-2'), recorded]
    })

    const listed = await listAiVaultSessions({ limit: 1, scopePaths: [linkedRepo] })

    expect(scanAiVaultSessionsInService.mock.calls[0]?.[0]).toMatchObject({
      scopePaths: [linkedRepo, realRepo]
    })
    expect(listed.sessions.find((entry) => entry.id === 'codex:s1')?.cwdAliases).toEqual([
      linkedRepo
    ])
    // The aliased row counts in scope, leaving only one out-of-scope row at depth 1.
    const cached = await listAiVaultSessions({ limit: 1, scopePaths: [linkedRepo] })
    expect(cached.sessions.map((entry) => entry.id)).toEqual(['codex:newer-1', 'codex:s1'])
  })
})
