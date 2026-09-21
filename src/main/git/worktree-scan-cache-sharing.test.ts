// Worktree scan sharing: in-flight coalescing and mutation-generation retirement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import {
  _getWorktreeScanCacheSizesForTests,
  _resetWorktreeScanCacheForTests,
  listWorktreeGraph,
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesStrict,
  moveWorktree,
  removeWorktree,
  notifyPreparedWorktreeMutation,
  WORKTREE_LIST_TIMEOUT_MS
} from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('listWorktrees in-flight sharing', () => {
  beforeEach(async () => {
    gitExecFileAsyncMock.mockReset()
    _resetWorktreeScanCacheForTests()
    // Why: capability discovery serializes same-host callers; warming it lets
    // these tests isolate the scan-generation overlap they are exercising.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    await listWorktrees('/capability-warmup')
    gitExecFileAsyncMock.mockReset()
  })

  // Later describes in this file assume a pristine mock (no global reset).
  afterEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('shares one scan across concurrent calls for the same repo', async () => {
    let resolveScan!: () => void
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = () => resolve({ stdout: scanOutput })
        })
    )

    const first = listWorktrees('/repo')
    const second = listWorktrees('/repo')
    resolveScan()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a[0]?.path).toBe('/repo')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('shares one graph scan across concurrent callers without sparse probes', async () => {
    let resolveScan!: () => void
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = () => resolve({ stdout: scanOutput })
        })
    )

    const first = listWorktreeGraph('/repo')
    const second = listWorktreeGraph('/repo')
    resolveScan()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a[0]?.path).toBe('/repo')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  // The annotated scan is the graph scan plus a sparse probe, so the two share one `git worktree
  // list` and only the annotated caller pays the probe. They ran Git twice before.
  it('runs one git listing for concurrent graph and annotated scans', async () => {
    const resolvers: ((value: { stdout: string }) => void)[] = []
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const graphScan = listWorktreeGraph('/repo')
    const annotatedScan = listWorktrees('/repo')
    expect(resolvers).toHaveLength(1)

    for (const resolve of resolvers) {
      resolve({ stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n' })
    }
    await Promise.all([graphScan, annotatedScan])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  // Order must not matter: whichever runs first owns the listing and the other joins it.
  it('runs one git listing when the annotated scan starts first', async () => {
    const resolvers: ((value: { stdout: string }) => void)[] = []
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const annotatedScan = listWorktrees('/repo')
    const graphScan = listWorktreeGraph('/repo')
    expect(resolvers).toHaveLength(1)

    for (const resolve of resolvers) {
      resolve({ stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n' })
    }
    await Promise.all([annotatedScan, graphScan])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('keeps graph scans with an AbortSignal isolated from shared callers', async () => {
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockResolvedValue({ stdout: scanOutput })
    const controller = new AbortController()

    await Promise.all([
      listWorktreeGraph('/repo'),
      listWorktreeGraph('/repo', { signal: controller.signal })
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('keeps graph scans with different visibility or timeout contracts separate', async () => {
    const resolvers: ((value: { stdout: string }) => void)[] = []
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const defaultScan = listWorktreeGraph('/repo')
    const preparationScan = listWorktreeGraph('/repo', { includeCreatePreparations: true })
    const shorterScan = listWorktreeGraph('/repo', { timeout: 5_000 })
    expect(resolvers).toHaveLength(3)

    for (const resolve of resolvers) {
      resolve({ stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n' })
    }
    await Promise.all([defaultScan, preparationScan, shorterScan])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('retires a graph scan that overlaps a worktree mutation', async () => {
    const resolvers: ((value: { stdout: string }) => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'worktree' && args[1] === 'list'
        ? new Promise((resolve) => {
            resolvers.push(resolve)
          })
        : Promise.resolve({ stdout: '' })
    )

    const staleScan = listWorktreeGraph('/repo')
    expect(resolvers).toHaveLength(1)
    notifyPreparedWorktreeMutation('/repo')
    const freshScan = listWorktreeGraph('/repo')
    expect(resolvers).toHaveLength(2)

    resolvers[1]?.({ stdout: 'worktree /repo\nHEAD fresh\nbranch refs/heads/main\n' })
    resolvers[0]?.({ stdout: 'worktree /repo\nHEAD stale\nbranch refs/heads/main\n' })
    expect((await freshScan)[0]?.head).toBe('fresh')
    expect((await staleScan)[0]?.head).toBe('stale')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
  })

  // Why (#16520): create verification moved off the fail-soft listing so a Git failure stops being
  // hidden behind "created but not found in listing". That must not cost the in-flight coalescing,
  // and sharing must never hand a strict caller a softened result.
  it('coalesces concurrent strict scans for the same repo into one git call', async () => {
    let resolveScan!: () => void
    const scanOutput = 'worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0'
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = () => resolve({ stdout: scanOutput })
        })
    )

    const first = listWorktreesSharedStrict('/repo')
    const second = listWorktreesSharedStrict('/repo')
    resolveScan()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a[0]?.path).toBe('/repo')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('propagates a shared strict failure to every joiner', async () => {
    let rejectScan!: (error: Error) => void
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = (error: Error) => reject(error)
        })
    )

    const first = listWorktreesSharedStrict('/repo')
    const second = listWorktreesSharedStrict('/repo')
    const settled = Promise.allSettled([first, second])
    rejectScan(new Error('git timed out.'))

    // A joiner silently receiving [] would be #16520 re-entering through the dedup path.
    expect((await settled).map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('never lets a strict caller join a fail-soft scan', async () => {
    // Both variants reject; only the lenient one is allowed to soften that into [].
    gitExecFileAsyncMock.mockRejectedValue(new Error('git timed out.'))

    const lenient = listWorktrees('/repo')
    const strict = listWorktreesSharedStrict('/repo')

    await expect(lenient).resolves.toEqual([])
    await expect(strict).rejects.toThrow('git timed out.')
  })

  it('keeps listWorktreesStrict unshared for post-mutation verification', async () => {
    // Why: a raw `git worktree prune` never bumps the scan generation, so a
    // coalesced strict read could return the pre-prune row and report a
    // successful removal as a stale registration.
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    const resolvers: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ stdout: scanOutput }))
        })
    )

    const first = listWorktreesStrict('/repo')
    const second = listWorktreesStrict('/repo')
    for (const resolve of resolvers) {
      resolve()
    }
    await Promise.all([first, second])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not share scans across different timeout contracts', async () => {
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockResolvedValue({ stdout: scanOutput })

    await Promise.all([listWorktrees('/repo'), listWorktrees('/repo', { timeout: 5_000 })])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ],
      [['worktree', 'list', '--porcelain', '-z'], { cwd: '/repo', timeout: 5_000 }]
    ])
  })

  it('runs a fresh scan once the shared one has settled', async () => {
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockResolvedValue({ stdout: scanOutput })

    await listWorktrees('/repo')
    await listWorktrees('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('runs a fresh scan after a timed-out shared scan settles', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('git timed out.'))
        .mockResolvedValueOnce({
          stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
        })

      await expect(listWorktrees('/repo')).resolves.toEqual([])
      await expect(listWorktrees('/repo')).resolves.toEqual([
        expect.objectContaining({ path: '/repo', head: 'abc123' })
      ])

      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
      expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('distinguishes fail-soft empty results from strict scan failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const failure = new Error('git spawn timed out')
      gitExecFileAsyncMock.mockRejectedValue(failure)

      await expect(listWorktrees('/repo')).resolves.toEqual([])
      await expect(listWorktreesStrict('/repo')).rejects.toBe(failure)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not share scans across different repos', async () => {
    gitExecFileAsyncMock.mockImplementation((_args: string[], options: { cwd: string }) =>
      Promise.resolve({
        stdout: `worktree ${options.cwd}\nHEAD abc123\nbranch refs/heads/main\n`
      })
    )

    await Promise.all([listWorktrees('/repo-one'), listWorktrees('/repo-two')])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not retain scan generations after mutations without active scans', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        moveWorktree(`/repo-${index}`, `/repo-${index}-old`, `/repo-${index}-new`)
      )
    )

    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
  })

  it('cleans mutation generations after stale scans settle and supports repo reuse', async () => {
    const scanResolvers: ((stdout: string) => void)[] = []
    let listCalls = 0
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCalls += 1
        return new Promise((resolve) => {
          scanResolvers.push((stdout) => resolve({ stdout }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const staleScan = listWorktrees('/repo')
    expect(scanResolvers).toHaveLength(1)

    await moveWorktree('/repo', '/repo-old', '/repo-new')
    // Two entries per annotated scan: its own, plus the graph listing it shares with probe-free callers.
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 2, generations: 1 })

    const freshScan = listWorktrees('/repo')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 4, generations: 1 })

    scanResolvers[1]?.('worktree /repo-new\nHEAD fresh\nbranch refs/heads/main\n')
    expect((await freshScan)[0]?.path).toBe('/repo-new')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 2, generations: 1 })

    scanResolvers[0]?.('worktree /repo\nHEAD stale\nbranch refs/heads/main\n')
    expect((await staleScan)[0]?.path).toBe('/repo')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })

    const firstReuse = listWorktrees('/repo')
    const secondReuse = listWorktrees('/repo')
    expect(listCalls).toBe(3)

    scanResolvers[2]?.('worktree /repo-reused\nHEAD reused\nbranch refs/heads/main\n')
    const [firstResult, secondResult] = await Promise.all([firstReuse, secondReuse])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult[0]?.path).toBe('/repo-reused')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
  })

  it('retires every overlapping scan generation across repeated mutations', async () => {
    const scanResolvers: (() => void)[] = []
    let listCalls = 0
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCalls += 1
        return new Promise((resolve) => {
          scanResolvers.push(() => resolve({ stdout: '' }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const oldestScan = listWorktrees('/repo')
    await moveWorktree('/repo', '/old-0', '/new-0')
    const middleScan = listWorktrees('/repo')
    await moveWorktree('/repo', '/old-1', '/new-1')
    const newestScan = listWorktrees('/repo')

    expect(listCalls).toBe(3)
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 6, generations: 1 })

    scanResolvers[0]?.()
    scanResolvers[2]?.()
    scanResolvers[1]?.()
    await Promise.all([oldestScan, middleScan, newestScan])

    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
  })

  it('keeps WSL scans distinct while retiring both after a mutation', async () => {
    const scanResolvers: (() => void)[] = []
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    await Promise.all([
      listWorktrees('/capability-warmup', { wslDistro: 'Ubuntu' }),
      listWorktrees('/capability-warmup', { wslDistro: 'Debian' })
    ])
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return new Promise((resolve) => {
          scanResolvers.push(() => resolve({ stdout: '' }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const staleUbuntu = listWorktrees('/repo', { wslDistro: 'Ubuntu' })
    const staleDebian = listWorktrees('/repo', { wslDistro: 'Debian' })
    expect(scanResolvers).toHaveLength(2)

    await removeWorktree('/repo', '/worktree', false, {
      knownRemovedWorktree: { branch: '', head: '' },
      wslDistro: 'Ubuntu'
    })
    const freshUbuntu = listWorktrees('/repo', { wslDistro: 'Ubuntu' })
    const freshDebian = listWorktrees('/repo', { wslDistro: 'Debian' })
    expect(scanResolvers).toHaveLength(4)

    for (const resolve of scanResolvers) {
      resolve()
    }
    await Promise.all([staleUbuntu, staleDebian, freshUbuntu, freshDebian])

    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 0, generations: 0 })
  })

  it('does not share scans for callers with an AbortSignal', async () => {
    const scanOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockResolvedValue({ stdout: scanOutput })
    const controller = new AbortController()

    // Why: an aborted shared scan would reject for every caller, so signal
    // callers must keep a private scan.
    await Promise.all([
      listWorktrees('/repo'),
      listWorktrees('/repo', { signal: controller.signal })
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
