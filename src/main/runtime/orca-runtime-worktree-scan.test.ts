import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo, WorktreeMeta } from '../../shared/types'
import {
  makeGitWorktree,
  makeRepo,
  makeScanRuntime,
  SCAN_CONCURRENCY,
  signalHonouringStrictScans,
  strictScansFor
} from './orca-runtime-worktree-scan-test-harness'

const { sshProviders, sshProviderGenerations } = vi.hoisted(() => ({
  sshProviders: new Map<string, { listWorktrees: ReturnType<typeof vi.fn> }>(),
  sshProviderGenerations: new Map<string, number>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()) }
}))

vi.mock('../git/worktree', () => ({
  // The lenient production API resolves [] on failure; runtime scans must use the strict API.
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([]),
  isNotGitRepositoryError: (error: unknown) =>
    /not a git repository/i.test(error instanceof Error ? error.message : String(error)),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: vi.fn(),
  addSparseWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  forceDeleteLocalBranch: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: (connectionId: string) => sshProviders.get(connectionId),
  getSshGitProviderGeneration: (connectionId: string) =>
    sshProviderGenerations.get(connectionId) ?? 0
}))

const { listWorktrees, listWorktreesStrict } = await import('../git/worktree')

const BASE_TTL_MS = 30_000
const MISSING_REPO_RETRY_MS = 5 * 60_000

function registerSshProvider(
  connectionId: string,
  listSshWorktrees: ReturnType<typeof vi.fn>
): void {
  sshProviders.set(connectionId, { listWorktrees: listSshWorktrees })
  sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
}

beforeEach(() => {
  vi.mocked(listWorktrees).mockReset().mockResolvedValue([])
  vi.mocked(listWorktreesStrict).mockReset().mockResolvedValue([])
  sshProviders.clear()
  sshProviderGenerations.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('worktree scan fleet', () => {
  it('derives local fleet size and activity from live panes, UI tabs, and active sessions', () => {
    const repos = [
      makeRepo('repo-pty', '/tmp/pty'),
      makeRepo('repo-ui', '/tmp/ui'),
      makeRepo('repo-session', '/tmp/session'),
      makeRepo('repo-idle', '/tmp/idle'),
      makeRepo('repo-ssh', '/remote/repo', { connectionId: 'ssh-1' }),
      makeRepo('repo-folder', '/tmp/folder', { kind: 'folder' })
    ]
    const runtime = makeScanRuntime(repos, {
      getWorkspaceSession: () => ({ activeWorktreeId: 'repo-session::/tmp/session' })
    })
    runtime.ptysById.set('pane', {
      worktreeId: 'repo-pty::/tmp/pty',
      connected: true
    })
    // An exited PTY record survives in the archive; it must not keep its repo eager.
    runtime.ptysById.set('exited', {
      worktreeId: 'repo-idle::/tmp/idle',
      connected: false
    })
    runtime.tabs.set('editor', { worktreeId: 'repo-ui::/tmp/ui' })
    runtime.ptysById.set('ssh-pane', { worktreeId: 'repo-ssh::/remote/repo', connected: true })

    const fleet = runtime.resolveWorktreeScanFleet(repos)

    expect(fleet.localRepoCount).toBe(4)
    // The rate budget is local-only, but sweep priority must cover the live SSH pane too.
    expect([...fleet.activeLocalRepoIds].sort()).toEqual(['repo-pty', 'repo-session', 'repo-ui'])
    expect([...fleet.activeRepoIds].sort()).toEqual([
      'repo-pty',
      'repo-session',
      'repo-ssh',
      'repo-ui'
    ])
  })

  it('returns the scanned worktree list and never calls the lenient API', async () => {
    const repo = makeRepo('repo-1', join(tmpdir(), 'repo-1'))
    const worktree = makeGitWorktree(repo.path)
    vi.mocked(listWorktreesStrict).mockResolvedValue([worktree])
    const runtime = makeScanRuntime([repo])

    const resolved = await runtime.listResolvedWorktrees()

    expect(resolved.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: `${repo.id}::${repo.path}`, path: repo.path }
    ])
    expect(resolved[0]?.git).toEqual(worktree)
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('detects a deleted local repo through the strict contract and backs it off', async () => {
    vi.useFakeTimers()
    const missingPath = join(tmpdir(), `orca-missing-${randomUUID()}`)
    const healthyPath = join(tmpdir(), 'healthy-repo')
    const healthyWorktree = makeGitWorktree(healthyPath)
    vi.mocked(listWorktreesStrict).mockImplementation(async (path: string) => {
      if (path === missingPath) {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
      }
      return [healthyWorktree]
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = makeScanRuntime([
      makeRepo('healthy', healthyPath),
      makeRepo('missing', missingPath)
    ])

    const first = await runtime.listResolvedWorktrees()
    expect(first.map((worktree) => worktree.path)).toEqual([healthyPath])
    expect([...runtime.worktreeScanBackoff.values()][0]?.kind).toBe('missing_repo_path')
    expect(listWorktrees).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BASE_TTL_MS + 1_000)
    const second = await runtime.listResolvedWorktrees()
    expect(second.map((worktree) => worktree.path)).toEqual([healthyPath])
    expect(strictScansFor(missingPath)).toBe(1)

    await vi.advanceTimersByTimeAsync(MISSING_REPO_RETRY_MS)
    await runtime.listResolvedWorktrees()
    expect(strictScansFor(missingPath)).toBe(2)
  })

  it('records scan_failed end to end and serves last-known local worktrees', async () => {
    vi.useFakeTimers()
    const repo = makeRepo('repo-1', tmpdir())
    const worktree = makeGitWorktree(repo.path)
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce([worktree])
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValue([worktree])
    const runtime = makeScanRuntime([repo])

    expect((await runtime.listResolvedWorktrees()).map((entry) => entry.path)).toEqual([repo.path])
    await vi.advanceTimersByTimeAsync(BASE_TTL_MS + 1_000)
    expect((await runtime.listResolvedWorktrees()).map((entry) => entry.path)).toEqual([repo.path])
    expect([...runtime.worktreeScanBackoff.values()][0]?.kind).toBe('scan_failed')

    await vi.advanceTimersByTimeAsync(10_000)
    expect((await runtime.listResolvedWorktrees()).map((entry) => entry.path)).toEqual([repo.path])
    expect(strictScansFor(repo.path)).toBe(2)

    await vi.advanceTimersByTimeAsync(21_000)
    expect((await runtime.listResolvedWorktrees()).map((entry) => entry.path)).toEqual([repo.path])
    expect(strictScansFor(repo.path)).toBe(3)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('preserves the legacy empty-success contract for a registered non-git directory', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    vi.mocked(listWorktreesStrict).mockRejectedValue(
      new Error('fatal: not a git repository (or any of the parent directories): .git')
    )
    const runtime = makeScanRuntime([repo])

    const result = await runtime.listRepoWorktreesForResolution(repo)

    expect(result).toEqual({ kind: 'success', origin: 'scan', worktrees: [] })
    expect(runtime.worktreeScanCache.size).toBe(1)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('keeps stored SSH worktrees visible while a failed provider is backed off', async () => {
    vi.useFakeTimers()
    const repo = makeRepo('repo-ssh', '/remote/repo', { connectionId: 'ssh-1' })
    const storedPath = '/remote/repo-linked'
    const listSshWorktrees = vi.fn().mockRejectedValue(new Error('connection lost'))
    registerSshProvider('ssh-1', listSshWorktrees)
    const runtime = makeScanRuntime([repo], {
      metaById: {
        [`${repo.id}::${storedPath}`]: { instanceId: 'stored-instance' } as WorktreeMeta
      }
    })

    const first = await runtime.listResolvedWorktrees()
    expect(first.map((worktree) => worktree.path)).toEqual([storedPath])
    expect([...runtime.worktreeScanBackoff.values()][0]?.kind).toBe('scan_failed')

    await vi.advanceTimersByTimeAsync(2_000)
    const backedOff = await runtime.listResolvedWorktrees()
    expect(backedOff.map((worktree) => worktree.path)).toEqual([storedPath])
    expect(listSshWorktrees).toHaveBeenCalledTimes(1)
  })

  it('isolates scan state for duplicate repo ids on different hosts', async () => {
    const localRepo = makeRepo('repo-shared', join(tmpdir(), 'shared-local'))
    const sshRepo = makeRepo('repo-shared', '/remote/shared', { connectionId: 'ssh-1' })
    const localWorktree = makeGitWorktree(localRepo.path)
    const sshWorktree = makeGitWorktree(sshRepo.path)
    vi.mocked(listWorktreesStrict).mockResolvedValue([localWorktree])
    const listSshWorktrees = vi.fn().mockResolvedValue([sshWorktree])
    registerSshProvider('ssh-1', listSshWorktrees)
    const runtime = makeScanRuntime([localRepo, sshRepo])

    await runtime.listRepoWorktreesForResolution(localRepo)
    await runtime.listRepoWorktreesForResolution(sshRepo)
    await runtime.listRepoWorktreesForResolution(localRepo)
    await runtime.listRepoWorktreesForResolution(sshRepo)

    expect(strictScansFor(localRepo.path)).toBe(1)
    expect(listSshWorktrees).toHaveBeenCalledTimes(1)
    expect(runtime.worktreeScanCache.size).toBe(2)

    runtime.invalidateRepoWorktreeScan(localRepo.id)
    await runtime.listRepoWorktreesForResolution(localRepo)
    await runtime.listRepoWorktreesForResolution(sshRepo)

    expect(strictScansFor(localRepo.path)).toBe(2)
    expect(listSshWorktrees).toHaveBeenCalledTimes(2)
  })

  it('filters stored SSH fallbacks by execution host', async () => {
    const localRepo = makeRepo('repo-shared', join(tmpdir(), 'fallback-local'))
    const sshRepo = makeRepo('repo-shared', '/remote/fallback', { connectionId: 'ssh-1' })
    const localStoredPath = join(tmpdir(), 'fallback-local-linked')
    const sshStoredPath = '/remote/fallback-linked'
    registerSshProvider('ssh-1', vi.fn().mockRejectedValue(new Error('connection lost')))
    const runtime = makeScanRuntime([localRepo, sshRepo], {
      metaById: {
        [`${localRepo.id}::${localStoredPath}`]: {
          instanceId: 'local-instance',
          hostId: 'local'
        } as unknown as WorktreeMeta,
        [`${sshRepo.id}::${sshStoredPath}`]: {
          instanceId: 'ssh-instance',
          hostId: 'ssh:ssh-1'
        } as unknown as WorktreeMeta
      }
    })

    await expect(runtime.listRepoWorktreesForResolution(sshRepo)).resolves.toEqual({
      kind: 'failure',
      reason: 'scan_failed',
      fallbackWorktrees: [expect.objectContaining({ path: sshStoredPath })]
    })
  })

  it('bounds parallel explicit scans with the same runtime-wide slot pool', async () => {
    const repos = Array.from({ length: 24 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `explicit-${index}`))
    )
    let inFlight = 0
    let peak = 0
    const release: (() => void)[] = []
    vi.mocked(listWorktreesStrict).mockImplementation(
      async (path: string) =>
        await new Promise<GitWorktreeInfo[]>((resolve) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          release.push(() => {
            inFlight -= 1
            resolve([makeGitWorktree(path)])
          })
        })
    )
    const runtime = makeScanRuntime(repos)
    const pending = Promise.all(repos.map((repo) => runtime.listRepoWorktreesForResolution(repo)))
    let settled = false
    void pending.then(() => {
      settled = true
    })

    for (let guard = 0; guard < 100 && !settled; guard += 1) {
      release.splice(0).forEach((resolve) => resolve())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    // Why: without this a wedged slot pool reports a suite timeout on the await below instead of the
    // invariant that actually broke.
    expect(settled).toBe(true)
    const results = await pending

    expect(peak).toBeLessThanOrEqual(SCAN_CONCURRENCY)
    expect(
      results.flatMap((result) =>
        result.kind === 'success' ? result.worktrees : result.fallbackWorktrees
      )
    ).toHaveLength(24)
  })

  it('coalesces IPC-facing detection with an overlapping runtime resolution scan', async () => {
    const repo = makeRepo('repo-1', join(tmpdir(), 'shared-scan'))
    const worktree = makeGitWorktree(repo.path)
    let resolveScan: ((worktrees: GitWorktreeInfo[]) => void) | undefined
    vi.mocked(listWorktreesStrict).mockImplementation(
      async () =>
        await new Promise<GitWorktreeInfo[]>((resolve) => {
          resolveScan = resolve
        })
    )
    const runtime = makeScanRuntime([repo])

    const detection = runtime.listRepoWorktreesForDetection(repo, 5_000)
    await vi.waitFor(() => expect(strictScansFor(repo.path)).toBe(1))
    const resolution = runtime.listResolvedWorktrees()
    await Promise.resolve()

    expect(strictScansFor(repo.path)).toBe(1)
    resolveScan?.([worktree])
    await expect(detection).resolves.toEqual({
      kind: 'success',
      origin: 'scan',
      worktrees: [worktree]
    })
    await expect(resolution).resolves.toEqual([
      expect.objectContaining({ id: `${repo.id}::${repo.path}`, path: repo.path })
    ])
  })

  it('reports whether a successful result came from a scan or the cache', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    const worktree = makeGitWorktree(repo.path)
    vi.mocked(listWorktreesStrict).mockResolvedValue([worktree])
    const runtime = makeScanRuntime([repo])

    await expect(runtime.listRepoWorktreesForDetection(repo, 5_000)).resolves.toEqual({
      kind: 'success',
      origin: 'scan',
      worktrees: [worktree]
    })
    await expect(runtime.listRepoWorktreesForDetection(repo, 5_000)).resolves.toEqual({
      kind: 'success',
      origin: 'cache',
      worktrees: [worktree]
    })
    expect(strictScansFor(repo.path)).toBe(1)
  })

  it('starts the detection cache age when a scan completes', async () => {
    vi.useFakeTimers()
    const repo = makeRepo('repo-1', tmpdir())
    const worktree = makeGitWorktree(repo.path)
    vi.mocked(listWorktreesStrict).mockImplementation(
      async () =>
        await new Promise<GitWorktreeInfo[]>((resolve) => {
          setTimeout(() => resolve([worktree]), 4_000)
        })
    )
    const runtime = makeScanRuntime([repo])

    const first = runtime.listRepoWorktreesForDetection(repo, 5_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(first).resolves.toMatchObject({ kind: 'success', origin: 'scan' })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(runtime.listRepoWorktreesForDetection(repo, 5_000)).resolves.toMatchObject({
      kind: 'success',
      origin: 'cache'
    })
    expect(strictScansFor(repo.path)).toBe(1)
  })

  it('marks an invalidated scan as a failure and keeps its replacement cached', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    const staleWorktree = makeGitWorktree(join(repo.path, 'stale'), 'stale')
    const freshWorktree = makeGitWorktree(join(repo.path, 'fresh'), 'fresh')
    const resolvers = signalHonouringStrictScans()
    const runtime = makeScanRuntime([repo])

    const stale = runtime.listRepoWorktreesForDetection(repo, 5_000)
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    runtime.invalidateRepoWorktreeScan(repo.id)
    const replacement = runtime.listRepoWorktreesForDetection(repo, 5_000)
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))

    resolvers[1]!([freshWorktree])
    await expect(replacement).resolves.toEqual({
      kind: 'success',
      origin: 'scan',
      worktrees: [freshWorktree]
    })
    // Invalidation drops the in-flight entry but must not kill a scan its caller is still waiting
    // on: that scan's own result is the only fallback left once invalidation cleared the cache.
    resolvers[0]!([staleWorktree])
    await expect(stale).resolves.toEqual({
      kind: 'failure',
      reason: 'invalidated',
      fallbackWorktrees: [staleWorktree]
    })
    await expect(runtime.listRepoWorktreesForDetection(repo, 5_000)).resolves.toEqual({
      kind: 'success',
      origin: 'cache',
      worktrees: [freshWorktree]
    })
    expect(strictScansFor(repo.path)).toBe(2)
  })

  it('does not run fresh-scan side effects from a detected scan invalidated while in flight', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    const staleWorktree = makeGitWorktree(join(repo.path, 'stale'), 'stale')
    const resolvers = signalHonouringStrictScans()
    const runtime = makeScanRuntime([repo])

    const originator = runtime.listRepoWorktreesForDetection(repo, 5_000)
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    const joiner = runtime.listRepoWorktreesForResolution(repo)
    expect(strictScansFor(repo.path)).toBe(1)
    runtime.invalidateRepoWorktreeScan(repo.id)
    resolvers[0]!([staleWorktree])

    // Neither waiter may surface an origin:'scan' success that would drive prune/remember.
    const invalidated = {
      kind: 'failure',
      reason: 'invalidated',
      fallbackWorktrees: [staleWorktree]
    }
    await expect(joiner).resolves.toEqual(invalidated)
    await expect(originator).resolves.toEqual(invalidated)
    expect(runtime.worktreeScanCache.size).toBe(0)
  })

  it('never backs off repos for slot-queue waits or scan timeouts', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 9 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `slot-race-${index}`))
    )
    const queuedPath = repos[8]!.path
    vi.mocked(listWorktreesStrict).mockImplementation(
      async (path: string, options?: { signal?: AbortSignal }) => {
        if (path === queuedPath) {
          return [makeGitWorktree(path)]
        }
        return await new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          )
        })
      }
    )
    const runtime = makeScanRuntime(repos)

    const pending = repos.map((repo) => runtime.listRepoWorktreesForResolution(repo))
    // Eight hung scans hold every slot past the 5s budget while repo-8 waits in the queue.
    await vi.advanceTimersByTimeAsync(5_001)
    const results = await Promise.all(pending)

    for (const result of results.slice(0, 8)) {
      expect(result).toEqual({ kind: 'failure', reason: 'cancelled', fallbackWorktrees: [] })
    }
    // The per-repo budget starts at slot acquire, so the queued repo still gets a real scan.
    expect(results[8]).toEqual({
      kind: 'success',
      origin: 'scan',
      worktrees: [makeGitWorktree(queuedPath)]
    })
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('applies runtime failure backoff to the IPC-facing detection entry point', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    vi.mocked(listWorktreesStrict).mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )
    const runtime = makeScanRuntime([repo])

    const first = await runtime.listRepoWorktreesForDetection(repo, 5_000)
    const backedOff = await runtime.listRepoWorktreesForDetection(repo, 5_000)

    expect(first).toEqual({
      kind: 'failure',
      reason: 'scan_failed',
      fallbackWorktrees: []
    })
    expect(backedOff).toEqual({
      kind: 'failure',
      reason: 'backoff',
      fallbackWorktrees: []
    })
    expect([...runtime.worktreeScanBackoff.values()][0]?.kind).toBe('scan_failed')
    expect(strictScansFor(repo.path)).toBe(1)
  })

  it('clears failure policy on invalidation and retries immediately', async () => {
    const repo = makeRepo('repo-1', tmpdir())
    const worktree = makeGitWorktree(repo.path)
    vi.mocked(listWorktreesStrict)
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValue([worktree])
    const runtime = makeScanRuntime([repo])

    const failed = await runtime.listRepoWorktreesForResolution(repo)
    expect(failed).toMatchObject({ kind: 'failure', reason: 'scan_failed' })
    expect(runtime.worktreeScanBackoff.size).toBe(1)

    runtime.invalidateWorktreeScanCacheForRepo(repo.id)
    const recovered = await runtime.listRepoWorktreesForResolution(repo)

    expect(recovered).toEqual({ kind: 'success', origin: 'scan', worktrees: [worktree] })
    expect(runtime.worktreeScanBackoff.size).toBe(0)
    expect(strictScansFor(repo.path)).toBe(2)
  })

  it('records policy even when an explicit caller starts the shared in-flight scan', async () => {
    vi.useFakeTimers()
    const repo = makeRepo('repo-1', tmpdir())
    let rejectScan: ((error: Error) => void) | undefined
    vi.mocked(listWorktreesStrict).mockImplementation(
      async () =>
        await new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
          rejectScan = reject
        })
    )
    const runtime = makeScanRuntime([repo])
    const explicit = runtime.listRepoWorktreesForResolution(repo)
    const sweep = runtime.listResolvedWorktrees()
    await vi.waitFor(() => expect(rejectScan).toBeTypeOf('function'))

    rejectScan?.(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(explicit).resolves.toMatchObject({ kind: 'failure', reason: 'scan_failed' })
    await sweep
    expect([...runtime.worktreeScanBackoff.values()][0]?.kind).toBe('scan_failed')

    await vi.advanceTimersByTimeAsync(2_000)
    await runtime.listResolvedWorktrees()
    expect(strictScansFor(repo.path)).toBe(1)
  })

  it('re-evaluates cached TTL when a repo becomes active', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `dynamic-${index}`))
    )
    vi.mocked(listWorktreesStrict).mockImplementation(async (path: string) => [
      makeGitWorktree(path)
    ])
    const runtime = makeScanRuntime(repos)

    expect(await runtime.listResolvedWorktrees()).toHaveLength(40)
    await vi.advanceTimersByTimeAsync(BASE_TTL_MS + 1_000)
    runtime.ptysById.set('pane', {
      worktreeId: `${repos[0]!.id}::${repos[0]!.path}`,
      connected: true
    })
    expect(await runtime.listResolvedWorktrees()).toHaveLength(40)

    expect(strictScansFor(repos[0]!.path)).toBe(2)
    expect(strictScansFor(repos[1]!.path)).toBe(1)
  })

  it('prunes scan state for repos removed outside the runtime API', async () => {
    vi.useFakeTimers()
    const repos = [makeRepo('repo-1', tmpdir())]
    vi.mocked(listWorktreesStrict).mockResolvedValue([makeGitWorktree(repos[0]!.path)])
    const runtime = makeScanRuntime(repos)
    await runtime.listResolvedWorktrees()
    runtime.worktreeScanBackoff.set('orphan-scan-key', {
      kind: 'scan_failed',
      failures: 1
    })
    runtime.worktreeScanGenerations.set('orphan-scan-key', 1)

    repos.splice(0)
    await vi.advanceTimersByTimeAsync(1_001)
    await runtime.listResolvedWorktrees()

    expect(runtime.worktreeScanCache.size).toBe(0)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
    expect(runtime.worktreeScanGenerations.size).toBe(0)
    expect(runtime.worktreeScanInFlight.size).toBe(0)
  })
})
