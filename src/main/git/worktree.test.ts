/* eslint-disable max-lines -- Why: addWorktree has multiple code paths (no refresh,
   owner reset safety, dirty worktree, diverged branch, custom remote) that each
   need dedicated test coverage. Splitting into separate files would scatter related tests
   without a meaningful boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'

import {
  addSparseWorktree,
  addWorktree,
  _getWorktreeScanCacheSizesForTests,
  _resetWorktreeScanCacheForTests,
  listWorktreeGraph,
  listWorktrees,
  moveWorktree,
  parseWorktreeList,
  removeWorktree,
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_LIST_TIMEOUT_MS
} from './worktree'

beforeEach(() => {
  clearGitCapabilityStateForTests()
})

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
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 1, generations: 1 })

    const freshScan = listWorktrees('/repo')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 2, generations: 1 })

    scanResolvers[1]?.('worktree /repo-new\nHEAD fresh\nbranch refs/heads/main\n')
    expect((await freshScan)[0]?.path).toBe('/repo-new')
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 1, generations: 1 })

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
    expect(_getWorktreeScanCacheSizesForTests()).toEqual({ inFlight: 3, generations: 1 })

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

describe('parseWorktreeList', () => {
  it('preserves a locked marker and its reason', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked active agent session\n'
      )[1]
    ).toMatchObject({
      path: '/locked',
      locked: true,
      lockReason: 'active agent session'
    })
  })

  it('decodes C-quoted lock reasons from legacy line porcelain output', () => {
    const output =
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked "first line\\nsecond line \\303\\251"\n'

    expect(parseWorktreeList(output)[1]).toMatchObject({
      locked: true,
      lockReason: 'first line\nsecond line é'
    })
  })

  it('keeps NUL-delimited lock reasons raw', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /locked',
      'HEAD def',
      'branch refs/heads/feature',
      'locked "literal\\nquote"',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      locked: true,
      lockReason: '"literal\\nquote"'
    })
  })

  it('preserves a prunable marker and its reason', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /stale\nHEAD def\nbranch refs/heads/feature\nprunable gitdir file points to non-existent location\n'
      )[1]
    ).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })

  it('preserves a NUL-delimited prunable marker', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /stale',
      'HEAD def',
      'branch refs/heads/feature',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })

  it('parses regular and bare worktree blocks from porcelain output', () => {
    const output = `
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-bare
HEAD 0000000
bare
`

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/repo-bare',
        head: '0000000',
        branch: '',
        isBare: true,
        isMainWorktree: false
      }
    ])
  })

  it('returns empty array for empty string input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(parseWorktreeList('   \n\n  \n  ')).toEqual([])
  })

  it('parses a single worktree block', () => {
    const output = `worktree /single-repo
HEAD aaa111
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/single-repo',
        head: 'aaa111',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('parses a detached HEAD worktree (no branch line)', () => {
    const output = `worktree /repo-detached
HEAD abc123
detached
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-detached',
        head: 'abc123',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('handles extra blank lines between blocks', () => {
    const output = `worktree /repo-a
HEAD aaa111
branch refs/heads/main


worktree /repo-b
HEAD bbb222
branch refs/heads/dev
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-a',
        head: 'aaa111',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-b',
        head: 'bbb222',
        branch: 'refs/heads/dev',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('returns entry with empty head when HEAD line is missing', () => {
    const output = `worktree /repo-no-head
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-no-head',
        head: '',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('correctly captures worktree path with spaces', () => {
    const output = `worktree /path/to/my worktree
HEAD ccc333
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/path/to/my worktree',
        head: 'ccc333',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('parses NUL-delimited porcelain output with newline paths', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/linked\nworktree',
      'HEAD def456',
      'branch refs/heads/feature/newline',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo/linked\nworktree',
        head: 'def456',
        branch: 'refs/heads/feature/newline',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('parses multiple bare entries mixed with regular entries', () => {
    const output = `worktree /bare-one
HEAD 0000000
bare

worktree /regular
HEAD abc123
branch refs/heads/main

worktree /bare-two
HEAD 1111111
bare
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/bare-one',
        head: '0000000',
        branch: '',
        isBare: true,
        isMainWorktree: true
      },
      {
        path: '/regular',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/bare-two',
        head: '1111111',
        branch: '',
        isBare: true,
        isMainWorktree: false
      }
    ])
  })
})

describe('listWorktreeGraph', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('returns the worktree graph without sparse-checkout annotation probes', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
    })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      }
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
  })

  it('falls back when older Git rejects worktree list -z with usage exit code', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('git usage error'), {
          code: 129,
          stderr: 'usage: git worktree list [<options>]\n'
        })
      )
      .mockResolvedValueOnce({
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-main-2
HEAD def456
branch refs/heads/main-2
`
      })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-main-2',
        head: 'def456',
        branch: 'refs/heads/main-2',
        isBare: false,
        isMainWorktree: false,
        // The line-block fallback also probes linked worktree paths for
        // existence (issue #8389), and this mocked path is absent on disk.
        prunable: true
      }
    ])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }]
    ])
  })

  it('falls back on a localized (non-English) older-Git usage error via exit code 129', async () => {
    // Git under a non-English locale translates the usage text, so stderr
    // matching alone misses it; the 129 exit code must still trigger fallback.
    gitExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('git worktree list --porcelain -z'), {
          code: 129,
          stderr: 'Fehler: Unbekannter Schalter »z«\nAufruf: git worktree list [<Optionen>]\n'
        })
      )
      .mockResolvedValueOnce({
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }]
    ])
  })

  it('does not retry without -z for non-usage Git failures', async () => {
    // A fatal error (exit 128) is not an unsupported-flag signal, so the -z
    // command must not be silently re-run without it.
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('git worktree list --porcelain -z'), {
        code: 128,
        stderr: 'fatal: unable to read tree\n'
      })
    )

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ]
    ])
  })

  it('returns an empty graph for paths Git reports as non-repositories', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: not a git repository'))

    await expect(listWorktreeGraph('/not-a-repo')).resolves.toEqual([])
  })

  it('lets callers override the default worktree list timeout', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    })

    await listWorktreeGraph('/repo', { timeout: 5_000 })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/repo',
      timeout: 5_000
    })
    expect(WORKTREE_LIST_TIMEOUT_MS).toBe(30_000)
  })
})

describe('addWorktree', () => {
  const resolveRemoteBase = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
  }

  const resolveCreationBaseConfigWrite = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
  }

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('creates the worktree without touching the local base ref by default', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }],
      [['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: '/repo-feature' }]
    ])
  })

  it('checks out a selected existing local branch without creating a new branch', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '/repo-feature', 'feature/test'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ]
    ])
  })

  it('bounds the worktree add call with a positive timeout (STA-1292 OneDrive stall guard)', async () => {
    // Why: without a timeout, a OneDrive cloud-placeholder checkout can stall
    // `git worktree add` for minutes. Assert the runner receives a non-zero
    // timeout so a stuck create fails fast instead of hanging forever.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    const worktreeAddCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv[0] === 'worktree' && argv[1] === 'add'
    )
    expect(worktreeAddCall?.[1]).toMatchObject({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    expect(WORKTREE_ADD_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('does not write branch base config when no base branch is provided', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set

    await addWorktree('/repo', '/repo-feature', 'feature/no-base')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/no-base', '/repo-feature'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('warns and unsets stale branch base config when persisting the base fails', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked')) // config --local --replace-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --unset-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set branch.feature/test.base for /repo-feature',
      expect.any(Error)
    )
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    warnSpy.mockRestore()
  })

  it('warns but does not throw when push.autoSetupRemote config fails', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get (unset, expected)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked')) // config --local set fails
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('warns and skips --local set when --get fails with non-unset error (e.g. corrupt config)', async () => {
    // Why: exit 1 from `git config --get` means "key unset" — anything else
    // is a real read failure (parse error, locked file). We must NOT fall
    // through to `--local set true`, which would silently overwrite whatever
    // value the user actually has.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('parse error'), { code: 3 })) // --get fails non-unset
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    // No --local set was attempted: only worktree add + the failing --get.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
    warnSpy.mockRestore()
  })

  it('preserves existing push.autoSetupRemote value (does not overwrite user-set false)', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'false\n' }) // config --get returns existing value

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    // No --local set: --get succeeded so we preserve the user's value.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('treats --get success with empty stdout as "already set" (key present but blank)', async () => {
    // Why: `git config --get key` exits 0 if the key has any value at any
    // scope, including the unusual case of an explicitly empty string. We
    // must not fall through to `--local set true` and overwrite that.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --get succeeds with empty value

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('does not write config when worktree add itself fails', async () => {
    // Why: a refactor that moves the config block earlier could try to write
    // push.autoSetupRemote against a worktree directory that was never
    // created. Pin the current ordering invariant: config calls happen only
    // after worktree add succeeds.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('worktree add failed'))

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).rejects.toThrow('worktree add failed')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ]
    ])
  })

  it('fast-forwards with reset --hard when localBranch is checked out in primary worktree', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
        { cwd: '/repo' }
      ],
      [['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [['merge-base', '--is-ancestor', 'old-main', 'remote-main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['reset', '--hard', 'remote-main'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }],
      [['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: '/repo-feature' }]
    ])
  })

  it('fast-forwards with reset --hard in sibling worktree when localBranch is checked out there', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n\nworktree /repo-main-wt\nHEAD def456\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls[6]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileAsyncMock.mock.calls[8]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]).toEqual([
      ['reset', '--hard', 'remote-main'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
  })

  it('fast-forwards local base via update-ref when localBranch is not checked out', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // update-ref refs/heads/main remote-main old-main
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    // Compare-and-swap form (expected old OID) so a concurrent ref move is a no-op.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    // No worktree owns the branch, so no working tree is reset.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'remote-main'
    ])
  })

  it('skips local base refresh when the owner worktree becomes dirty before mutation', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'refs/heads/main'
    ])
  })

  it('skips local base refresh when the owner worktree switches branches before mutation', async () => {
    const firstWorktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    const secondWorktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: firstWorktreeListOutput }) // worktree list during evaluation
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockResolvedValueOnce({ stdout: secondWorktreeListOutput }) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'refs/heads/main'
    ])
  })

  it('skips local base refresh when owner revalidation cannot list worktrees', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list during evaluation
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockRejectedValueOnce(new Error('worktree list failed')) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
  })

  it('skips update when the owning worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain (dirty)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })

    // No reset --hard or update-ref — just base resolution, drift check, local/remote
    // OIDs, ancestry check, worktree list, status, worktree add, and config writes.
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(11)
    expect(gitExecFileAsyncMock.mock.calls[0]?.[0]).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main^{commit}'
    ])
    expect(gitExecFileAsyncMock.mock.calls[7]?.[0]).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature/test',
      '/repo-feature',
      'refs/remotes/origin/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[8]?.[0]).toEqual([
      'config',
      '--local',
      '--replace-all',
      'branch.feature/test.base',
      'refs/remotes/origin/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]?.[0]).toEqual([
      'config',
      '--get',
      'push.autoSetupRemote'
    ])
    expect(gitExecFileAsyncMock.mock.calls[10]?.[0]).toEqual([
      'config',
      '--local',
      'push.autoSetupRemote',
      'true'
    ])
  })

  it('skips updating the local branch when it has diverged', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not a fast-forward'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--get', 'push.autoSetupRemote'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ]
    ])
  })

  it('skips local base refresh when captured OIDs are no longer ancestor-safe', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '0\t2\n' }) // stale rev-list result
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'new-local\n' }) // rev-parse refs/heads/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not an ancestor')) // merge-base captured OIDs
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['merge-base', '--is-ancestor', 'new-local', 'remote-main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--get', 'push.autoSetupRemote'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ]
    ])
  })

  it('suggests updating the local base ref when setting is off and the branch is safely behind', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
      { cwd: '/repo' }
    ])
  })

  it('skips advisory owner probes when the local base is already current', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // resolve creation base
      .mockResolvedValueOnce({ stdout: '0\t0\n' }) // local base is current
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // persist branch base
      .mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', false, false, {
        suggestLocalBaseRefUpdate: true
      })
    ).resolves.toEqual({})

    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/test',
        '/repo-feature',
        'refs/remotes/origin/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/test.base',
        'refs/remotes/origin/main'
      ],
      ['config', '--get', 'push.autoSetupRemote']
    ])
  })

  it('uses normalized branch metadata for slash-containing remotes', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'foo/bar/main',
      false,
      false,
      {
        suggestLocalBaseRefUpdate: true,
        remoteTrackingBase: {
          base: 'foo/bar/main',
          branch: 'main',
          ref: 'refs/remotes/foo/bar/main'
        }
      }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'foo/bar/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/foo/bar/main'],
      { cwd: '/repo' }
    ])
  })

  it('does not suggest updating the local base ref when its owner worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-upstream-main\n' }) // rev-parse refs/remotes/upstream/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result).toEqual({})
  })

  it('qualifies bare branch name as refs/heads/ when a same-named tag exists', async () => {
    // Why: repos that fetch with --tags can end up with a local tag named 'main',
    // making `git worktree add ... main` fail with "fatal: Ambiguous object name".
    // Qualifying as refs/heads/main tells git exactly which object to use.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/disambig', 'main')

    expect(gitExecFileAsyncMock.mock.calls[0]).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
      { cwd: '/repo' }
    ])
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/disambig',
        '/repo-feature',
        'refs/heads/main'
      ],
      { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
  })

  it('qualifies slash-containing local branch names when no remote ref matches', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('no remote ref')) // rev-parse refs/remotes/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/release', 'release/main')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/release/main^{commit}'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/release/main^{commit}'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/release',
        '/repo-feature',
        'refs/heads/release/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/release.base',
        'refs/heads/release/main'
      ],
      ['config', '--get', 'push.autoSetupRemote'],
      ['config', '--local', 'push.autoSetupRemote', 'true']
    ])
  })

  it('does not report a local base refresh for slash-containing local branch names', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('no remote ref')) // rev-parse refs/remotes/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/release',
      'release/main',
      true
    )

    expect(result).toEqual({})
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/release/main^{commit}'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/release/main^{commit}'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/release',
        '/repo-feature',
        'refs/heads/release/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/release.base',
        'refs/heads/release/main'
      ],
      ['config', '--get', 'push.autoSetupRemote'],
      ['config', '--local', 'push.autoSetupRemote', 'true']
    ])
  })

  it('uses the remote name from the base ref instead of hardcoding origin', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/upstream/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-upstream-main\n' }) // rev-parse refs/remotes/upstream/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main', true)

    expect(gitExecFileAsyncMock.mock.calls[1]?.[0]).toEqual([
      'rev-list',
      '--left-right',
      '--count',
      'refs/heads/main...refs/remotes/upstream/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]?.[0]).toEqual([
      'reset',
      '--hard',
      'remote-upstream-main'
    ])
  })

  it('unsets branch base config during sparse setup cleanup after creation succeeds', async () => {
    const beforeRemoval =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('sparse setup failed')) // sparse-checkout init
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --unset-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval }) // worktree list before remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -D (rollback force-deletes the fresh branch)

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['src'], 'origin/main')
    ).rejects.toThrow('sparse setup failed')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    // Why: rolling back a failed creation force-deletes the just-created branch
    // (`-D`) — it has no user commits to protect, unlike a user-initiated delete.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-D',
      '--',
      'feature/test'
    ])
  })
})

describe('moveWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs `git worktree move` from the repo with old and new paths', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await moveWorktree('/repo', '/ws/cunner', '/ws/worktree-creation-spinner')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['worktree', 'move', '/ws/cunner', '/ws/worktree-creation-spinner'],
      { cwd: '/repo' }
    )
  })

  it('propagates git failures so the caller can fall back', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: destination exists'))
    await expect(moveWorktree('/repo', '/ws/cunner', '/ws/taken')).rejects.toThrow(
      'destination exists'
    )
  })
})

describe('removeWorktree', () => {
  const beforeRemoval =
    'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('uses safe `branch -d` and preserves a branch with unmerged commits', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval }) // list before
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    // Git refuses to delete an unmerged branch with `-d`.
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not fully merged')) // branch -d

    // Should not throw — the unmerged branch is preserved, not force-deleted.
    await expect(removeWorktree('/repo', '/repo-feature', false)).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0])
    expect(calls).toContainEqual(['branch', '-d', '--', 'feature/test'])
    expect(calls).not.toContainEqual(['branch', '-D', '--', 'feature/test'])
  })

  it('deletes the branch when `branch -d` succeeds (fully merged)', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval }) // list before
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -d succeeds

    await removeWorktree('/repo', '/repo-feature', false)

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-d',
      '--',
      'feature/test'
    ])
  })

  it('reuses known removed worktree metadata instead of relisting before removal', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -d succeeds

    await removeWorktree('/repo', '/repo-feature', false, {
      knownRemovedWorktree: {
        branch: 'refs/heads/feature/test',
        head: 'def456'
      }
    })

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'remove', '/repo-feature'],
      ['branch', '-d', '--', 'feature/test']
    ])
  })

  it('prunes and retries branch deletion only when Git reports a checked-out branch', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval }) // list before
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockRejectedValueOnce(
      new Error("error: cannot delete branch 'feature/test' used by worktree at '/repo-stale'")
    ) // branch -d hits stale worktree metadata
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree prune
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -d retry succeeds

    await expect(removeWorktree('/repo', '/repo-feature', false)).resolves.toEqual({})

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'list', '--porcelain', '-z'],
      ['worktree', 'remove', '/repo-feature'],
      ['branch', '-d', '--', 'feature/test'],
      ['worktree', 'prune'],
      ['branch', '-d', '--', 'feature/test']
    ])
  })
})
