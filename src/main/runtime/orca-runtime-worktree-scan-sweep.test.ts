import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo, WorktreeMeta } from '../../shared/types'
import {
  FLEET_MAX_WAVES,
  FLEET_TIMEOUT_MS,
  makeGitWorktree,
  makeRepo,
  makeScanRuntime,
  mockHungStrictScans,
  mockStrictScansWedgedBy,
  mockStrictScansWithLatency,
  REPO_TIMEOUT_MS,
  SCAN_CONCURRENCY
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

const { listWorktreesStrict } = await import('../git/worktree')

function registerSshProvider(
  connectionId: string,
  listSshWorktrees: ReturnType<typeof vi.fn>
): void {
  sshProviders.set(connectionId, { listWorktrees: listSshWorktrees })
  sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
}

beforeEach(() => {
  vi.mocked(listWorktreesStrict).mockReset().mockResolvedValue([])
  sshProviders.clear()
  sshProviderGenerations.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * The sweep's own budget: how a fleet deadline turns into waves, what a wedged repo costs the ones
 * behind it, and what a truncated sweep leaves for the next one.
 */
describe('worktree scan sweep budget', () => {
  it('aborts timed-out git processes before freeing slots and stops a wedged fleet at the ceiling', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `repo-${index}`))
    )
    const hung = mockHungStrictScans()
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS - 1)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(SCAN_CONCURRENCY)

    // A wave that completes nothing reads the same whether the fleet is wedged or only its head is,
    // so it never ends the sweep: each wave's deadline frees its slots and the next wave spawns...
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(SCAN_CONCURRENCY * 2)
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(SCAN_CONCURRENCY * FLEET_MAX_WAVES)

    // ...until the wave ceiling stops it. The repos still queued are skipped, not spawned.
    await vi.advanceTimersByTimeAsync(2)
    const result = await pending

    expect(result).toEqual([])
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(SCAN_CONCURRENCY * FLEET_MAX_WAVES)
    expect(hung.peakProcesses).toBeLessThanOrEqual(SCAN_CONCURRENCY)
    expect(hung.liveProcesses).toBe(0)
    expect(runtime.activeLocalWorktreeScanCount).toBe(0)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('stops a small wedged fleet after its own wave count instead of the three-wave ceiling', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 12 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `small-${index}`))
    )
    const hung = mockHungStrictScans()
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS * 2 + 1)

    // 12 repos is two waves, so a fleet that answers nothing is done at 10s, not 15s.
    expect(await pending).toEqual([])
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(12)
    expect(hung.liveProcesses).toBe(0)
  })

  it('scans the healthy tail when the first wave is wedged', async () => {
    vi.useFakeTimers()
    // The 8 wedged repos sort first, so wave 1 completes nothing — but 32 healthy repos sit behind
    // them, and giving up on a wave that completed nothing never spawned a single one of them.
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `hol-${String(index).padStart(2, '0')}`))
    )
    mockStrictScansWedgedBy(/hol-0[0-7]$/, 200)
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect(await pending).toHaveLength(32)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(40)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('keeps surfacing the healthy tail on later sweeps while the head stays wedged', async () => {
    vi.useFakeTimers()
    // Cancelled repos are never backed off, so a wedged head sorts identically on every sweep — the
    // tail must not be starved by it repeatedly.
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `stuck-${String(index).padStart(2, '0')}`))
    )
    mockStrictScansWedgedBy(/stuck-0[0-7]$/, 200)
    const runtime = makeScanRuntime(repos)

    const lengths: number[] = []
    for (let sweep = 0; sweep < 5; sweep += 1) {
      const pending = runtime.listResolvedWorktrees()
      await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
      lengths.push((await pending).length)
      await vi.advanceTimersByTimeAsync(1_100)
    }

    expect(lengths).toEqual([32, 32, 32, 32, 32])
  })

  it('scans the healthy tail behind a wedged head wider than the concurrency cap', async () => {
    vi.useFakeTimers()
    // The head-of-line class has no threshold: 16 wedged repos are two full waves, so any rule that
    // spends a fixed number of unproductive waves before giving up starves this tail forever.
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `wide-${String(index).padStart(2, '0')}`))
    )
    mockStrictScansWedgedBy(/wide-(0[0-9]|1[0-5])$/, 200)
    const runtime = makeScanRuntime(repos)

    const lengths: number[] = []
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const pending = runtime.listResolvedWorktrees()
      await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
      lengths.push((await pending).length)
      await vi.advanceTimersByTimeAsync(1_100)
    }

    expect(lengths).toEqual([24, 24, 24])
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('completes a slow-but-healthy fleet that fits inside the fleet deadline', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `slow-${index}`))
    )
    // 40 repos / 8 slots = 5 batches x 200ms = 1s, well inside the fleet budget.
    mockStrictScansWithLatency(200)
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect(await pending).toHaveLength(40)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(40)
  })

  it('completes a cold sweep of a fleet far larger than the concurrency cap', async () => {
    vi.useFakeTimers()
    // The regression case: 107 local repos is 14 waves, so a flat one-wave deadline dropped every
    // repo past ~370ms of scan latency on a cold cache. 14 x 700ms = 9.8s must still fit.
    const repos = Array.from({ length: 107 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `fleet-${index}`))
    )
    mockStrictScansWithLatency(700)
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect(await pending).toHaveLength(107)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(107)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('frees every slot as soon as the fleet deadline fires', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `zombie-${index}`))
    )
    let liveProcesses = 0
    // Wave 1 settles at 1s and nothing completes after it, so the sweep runs out its 3-wave ceiling
    // at 15s — the wave holding slots then still has 1s of its own budget left.
    vi.mocked(listWorktreesStrict).mockImplementation(
      async (path: string, options?: { signal?: AbortSignal }) => {
        liveProcesses += 1
        try {
          return await new Promise<GitWorktreeInfo[]>((resolve, reject) => {
            if (/-[0-7]$/.test(path)) {
              setTimeout(() => resolve([makeGitWorktree(path)]), 1_000)
              return
            }
            options?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            )
          })
        } finally {
          liveProcesses -= 1
        }
      }
    )
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS * 3 - 1)
    expect(liveProcesses).toBe(8)

    await vi.advanceTimersByTimeAsync(2)
    await pending

    // Without fleet-signal cancellation these 8 would hold slots for another ~1s of dead time.
    expect(liveProcesses).toBe(0)
    expect(runtime.activeLocalWorktreeScanCount).toBe(0)
    expect(runtime.worktreeScanInFlight.size).toBe(0)
    expect(runtime.worktreeScanBackoff.size).toBe(0)
  })

  it('truncates a fleet slower than the deadline and fills it in on the next sweep', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `sluggish-${index}`))
    )
    // 4s per repo: waves land at 4s/8s/12s, the 4th is still running at the 15s deadline.
    mockStrictScansWithLatency(4_000)
    const runtime = makeScanRuntime(repos)

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
    const truncated = await pending

    expect(truncated).toHaveLength(SCAN_CONCURRENCY * FLEET_MAX_WAVES)
    // Repos past the deadline are skipped, not spawned-then-abandoned.
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(
      SCAN_CONCURRENCY * (FLEET_MAX_WAVES + 1)
    )
    expect(runtime.worktreeScanBackoff.size).toBe(0)

    // The 3 landed waves are cached; the wave cancelled at the deadline and the one never started rescan.
    await vi.advanceTimersByTimeAsync(1_100)
    const next = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect(await next).toHaveLength(repos.length)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(
      SCAN_CONCURRENCY * (FLEET_MAX_WAVES + 3)
    )
  })

  it('keeps a joined scan alive when the originating sweep hits its fleet deadline', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `joined-${index}`))
    )
    // 4s per repo: waves land at 4s/8s/12s, so wave 4 is still running at the 15s fleet deadline.
    mockStrictScansWithLatency(4_000)
    const runtime = makeScanRuntime(repos)

    const sweep = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(12_500)
    const joinedRepo = repos[24]!
    const detection = runtime.listRepoWorktreesForDetection(joinedRepo, 5_000)
    const spawnsBeforeJoin = vi.mocked(listWorktreesStrict).mock.calls.length

    await vi.advanceTimersByTimeAsync(4_000)

    // The detection joined the sweep's scan rather than spawning its own...
    expect(vi.mocked(listWorktreesStrict).mock.calls.length).toBe(spawnsBeforeJoin)
    // ...and the sweep's deadline may not cancel it: the scan lands at 16s on its own budget.
    await expect(detection).resolves.toEqual({
      kind: 'success',
      origin: 'scan',
      worktrees: [makeGitWorktree(joinedRepo.path)]
    })
    expect(await sweep).toHaveLength(24)
  })

  it('bounds a hung SSH scan by the per-repo deadline instead of pinning a sweep worker', async () => {
    vi.useFakeTimers()
    const repo = makeRepo('repo-ssh', '/remote/repo', { connectionId: 'ssh-1' })
    const storedPath = '/remote/repo-linked'
    let providerSignal: AbortSignal | undefined
    registerSshProvider(
      'ssh-1',
      vi.fn(
        async (_path: string, options?: { signal?: AbortSignal }) =>
          await new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
            providerSignal = options?.signal
            options?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            )
          })
      )
    )
    const runtime = makeScanRuntime([repo], {
      metaById: {
        [`${repo.id}::${storedPath}`]: { instanceId: 'stored-instance' } as WorktreeMeta
      }
    })

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(REPO_TIMEOUT_MS + 1)

    expect((await pending).map((worktree) => worktree.path)).toEqual([storedPath])
    // A relay that ran out of time is contention, not repo health.
    expect(runtime.worktreeScanBackoff.size).toBe(0)
    expect(runtime.worktreeScanInFlight.size).toBe(0)
    expect(providerSignal?.aborted).toBe(true)
  })

  it('scans repos with a live pane before idle repos so truncation lands on idle ones', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `ordered-${index}`))
    )
    mockStrictScansWithLatency(4_000)
    const runtime = makeScanRuntime(repos)
    // repo-39 is last in repo order but the only one with a pane, so it must scan in the first wave.
    runtime.ptysById.set('pty-1', {
      worktreeId: `repo-39::${join(tmpdir(), 'ordered-39')}`,
      connected: true
    })

    const pending = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect((await pending).map((worktree) => worktree.path)).toContain(join(tmpdir(), 'ordered-39'))
  })

  it('rotates a wedged head that fills the wave ceiling so the healthy tail is not starved forever', async () => {
    vi.useFakeTimers()
    // Three waves × 8 slots = 24: a wedged prefix this wide consumes every wave of one sweep.
    // Without cross-sweep deprioritization the same 24 sort first every time and the 16 healthy
    // repos never spawn ([0,0,0] forever). After sweep 1 the wedged head is deprioritized, so
    // sweep 2 lands the healthy tail.
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `cliff-${String(index).padStart(2, '0')}`))
    )
    mockStrictScansWedgedBy(/cliff-(0[0-9]|1[0-9]|2[0-3])$/, 200)
    const runtime = makeScanRuntime(repos)

    const first = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
    expect(await first).toHaveLength(0)
    expect(vi.mocked(listWorktreesStrict)).toHaveBeenCalledTimes(24)

    await vi.advanceTimersByTimeAsync(1_100)
    const second = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
    expect(await second).toHaveLength(16)

    await vi.advanceTimersByTimeAsync(1_100)
    const third = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
    expect(await third).toHaveLength(16)
  })

  it('rotates cancelled active repos behind a healthy idle tail', async () => {
    vi.useFakeTimers()
    const repos = Array.from({ length: 40 }, (_, index) =>
      makeRepo(`repo-${index}`, join(tmpdir(), `active-cliff-${String(index).padStart(2, '0')}`))
    )
    mockStrictScansWedgedBy(/active-cliff-(0[0-9]|1[0-9]|2[0-3])$/, 200)
    const runtime = makeScanRuntime(repos)
    repos.slice(0, 24).forEach((repo, index) => {
      runtime.ptysById.set(`pty-${index}`, {
        worktreeId: `${repo.id}::${repo.path}`,
        connected: true
      })
    })

    const first = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)
    expect(await first).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_100)
    const second = runtime.listResolvedWorktrees()
    await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS + 1)

    expect(await second).toHaveLength(16)
  })
})
