import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { exec, guard, spend } = vi.hoisted(() => ({ exec: vi.fn(), guard: vi.fn(), spend: vi.fn() }))
vi.mock('./gh-utils', () => ({ ghExecFileAsync: exec }))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: guard,
  noteRepositoryRateLimitSpend: spend
}))

import { detectRepositoryMergeMetadata } from './client/detect/repository-merge-metadata'
import { _resetMergeQueueCacheForTests } from './client/detect/repository-merge-metadata-cache'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const options = { cwd: '/repo' }

function response(autoMergeAllowed: boolean): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: { repository: { autoMergeAllowed, mergeQueue: null, ref: { rules: { nodes: [] } } } }
    })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('GH_CONFIG_DIR', undefined)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  _resetMergeQueueCacheForTests()
  guard.mockReturnValue({ blocked: false })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('repository merge metadata reuse', () => {
  it('isolates cwd when no home or config directory is available', async () => {
    const env = { PATH: '/fixture/bin' }
    exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))
    await detectRepositoryMergeMetadata(repository, 'main', { cwd: '/a', env }, 'local:host')
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', { cwd: '/b', env }, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])(
    'retains a successful concurrent read when a newer read fails (failure first: %s)',
    async (failureFirst) => {
      const older = Promise.withResolvers<{ stdout: string }>()
      const newer = Promise.withResolvers<{ stdout: string }>()
      exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
      const second = detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree' },
        'local:host'
      )
      if (failureFirst) {
        newer.reject(new Error('ECONNRESET'))
        await second
        older.resolve(response(true))
        await first
      } else {
        older.resolve(response(true))
        await first
        newer.reject(new Error('ECONNRESET'))
        await second
      }
      await expect(
        detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
      ).resolves.toMatchObject({ autoMergeAllowed: true })
      expect(exec).toHaveBeenCalledTimes(2)
    }
  )

  it('starts immediately and joins overlapping PR probes for the same base branch', async () => {
    const pending = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(pending.promise)

    const reads = Array.from({ length: 10 }, () =>
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    )

    expect(exec).toHaveBeenCalledTimes(1)
    pending.resolve(response(true))
    expect(await Promise.all(reads)).toEqual(
      Array.from({ length: 10 }, () => ({ autoMergeAllowed: true, mergeQueueRequired: false }))
    )
    expect(spend).toHaveBeenCalledTimes(1)
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('reuses context across admission tiers but refreshes at the existing TTL', async () => {
    vi.useFakeTimers()
    exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))

    await detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, admissionTier: 'interactive' },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * 60_000)

    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('keeps repository-wide settings distinct from a branch with the old sentinel name', async () => {
    exec.mockResolvedValue(response(true))

    const [all, branch] = await Promise.all([
      detectRepositoryMergeMetadata(repository, undefined, options, 'local:host'),
      detectRepositoryMergeMetadata(repository, '__repo__', options, 'local:host')
    ])

    expect(all.mergeQueueRequired).toBeNull()
    expect(branch.mergeQueueRequired).toBe(false)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('preserves repository-wide cache reuse across different worktree directories', async () => {
    exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))

    await detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', { cwd: '/another-worktree' }, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: true })

    expect(exec).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['GH_CONFIG_DIR', false],
    ['GH_CONFIG_DIR', true],
    ['XDG_CONFIG_HOME', false],
    ['XDG_CONFIG_HOME', true]
  ] as const)('isolates relative %s directories (inherited: %s)', async (variable, inherited) => {
    vi.stubEnv(variable, '.gh')
    const env = inherited ? undefined : { [variable]: '.gh' }
    exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))

    await detectRepositoryMergeMetadata(repository, 'main', { ...options, env }, 'local:host')
    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree', env },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('honors an absolute config override above a relative XDG directory', async () => {
    const env = {
      GH_CONFIG_DIR: process.platform === 'win32' ? 'C:\\gh' : '/home/gh',
      XDG_CONFIG_HOME: '.xdg'
    }
    exec.mockResolvedValueOnce(response(true))

    await detectRepositoryMergeMetadata(repository, 'main', { ...options, env }, 'local:host')
    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree', env },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'Ubuntu'])(
    'isolates a relative default config directory in %s',
    async (wslDistro) => {
      const env =
        !wslDistro && process.platform === 'win32' ? { APPDATA: '.gh' } : { HOME: '.home' }
      exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))

      await detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, env, wslDistro },
        'local:host'
      )
      await expect(
        detectRepositoryMergeMetadata(
          repository,
          'main',
          { cwd: '/another-worktree', env, wslDistro },
          'local:host'
        )
      ).resolves.toMatchObject({ autoMergeAllowed: false })
      expect(exec).toHaveBeenCalledTimes(2)
    }
  )

  it.each([undefined, 'Ubuntu'])('shares an absolute config directory in %s', async (wslDistro) => {
    const configDir = !wslDistro && process.platform === 'win32' ? 'C:\\gh' : '/home/gh'
    const env = { GH_CONFIG_DIR: configDir }
    exec.mockResolvedValueOnce(response(true))

    await detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, env, wslDistro },
      'local:host'
    )
    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree', env, wslDistro },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('keeps Windows-looking relative config paths isolated inside WSL', async () => {
    const env = { GH_CONFIG_DIR: 'C:\\gh' }
    exec.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false))

    await detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, env, wslDistro: 'Ubuntu' },
      'local:Ubuntu'
    )
    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree', env, wslDistro: 'Ubuntu' },
        'local:Ubuntu'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('does not couple independent abort signals or cache an aborted result', async () => {
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const surviving = Promise.withResolvers<{ stdout: string }>()
    const firstController = new AbortController()
    const secondController = new AbortController()
    exec.mockReturnValueOnce(canceled.promise).mockReturnValueOnce(surviving.promise)
    const first = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: firstController.signal },
      'local:host'
    )
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: secondController.signal },
      'local:host'
    )
    expect(exec).toHaveBeenCalledTimes(2)
    firstController.abort()
    canceled.reject(firstController.signal.reason)
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: null })
    surviving.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('retries immediately with a new signal after the only probe aborts', async () => {
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const controller = new AbortController()
    exec.mockReturnValueOnce(canceled.promise).mockResolvedValueOnce(response(true))
    const first = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: controller.signal },
      'local:host'
    )
    controller.abort()
    canceled.reject(controller.signal.reason)
    await first

    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, signal: new AbortController().signal },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('still coalesces a shared signal and reuses its successful completed result', async () => {
    const pending = Promise.withResolvers<{ stdout: string }>()
    const signal = new AbortController().signal
    exec.mockReturnValueOnce(pending.promise)
    const reads = Array.from({ length: 10 }, () =>
      detectRepositoryMergeMetadata(repository, 'main', { ...options, signal }, 'local:host')
    )
    expect(exec).toHaveBeenCalledTimes(1)
    pending.resolve(response(true))
    await Promise.all(reads)

    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('retains a surviving cache writer when a newer independent probe aborts', async () => {
    const older = Promise.withResolvers<{ stdout: string }>()
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const controller = new AbortController()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(canceled.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: controller.signal },
      'local:host'
    )
    controller.abort()
    canceled.reject(controller.signal.reason)
    await second
    older.resolve(response(false))
    await first

    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('does not spend quota for an already aborted probe', async () => {
    const controller = new AbortController()
    controller.abort()
    exec.mockResolvedValue(response(true))

    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, signal: controller.signal },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: null })
    expect(exec).not.toHaveBeenCalled()
    expect(spend).not.toHaveBeenCalled()
  })

  it('keeps inferred WSL distro credentials separate from native and other distros', async () => {
    exec.mockResolvedValueOnce(response(true)).mockResolvedValue(response(false))

    await detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    for (const cwd of ['\\\\wsl.localhost\\Ubuntu\\repo', '\\\\wsl.localhost\\Debian\\repo']) {
      await expect(
        detectRepositoryMergeMetadata(repository, 'main', { cwd }, 'local:host')
      ).resolves.toMatchObject({ autoMergeAllowed: false })
    }

    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('keeps newer worktree settings when an older directory probe completes later', async () => {
    const older = Promise.withResolvers<{ stdout: string }>()
    const newer = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { cwd: '/another-worktree' },
      'local:host'
    )

    newer.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    older.resolve(response(true))
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: true })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('isolates credential/host/branch/route caches and cwd-sensitive overlapping probes', async () => {
    const pending = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValue(pending.promise)
    const requests = [
      { repository, branch: 'main', options, scope: 'local:host' },
      { repository, branch: 'release', options, scope: 'local:host' },
      {
        repository: { ...repository, host: 'ghe.example' },
        branch: 'main',
        options,
        scope: 'local:host'
      },
      { repository, branch: 'main', options, scope: 'ssh:one' },
      { repository, branch: 'main', options, scope: 'ssh:two' },
      {
        repository,
        branch: 'main',
        options: { ...options, wslDistro: 'Ubuntu' },
        scope: 'local:Ubuntu'
      },
      {
        repository,
        branch: 'main',
        options: { ...options, cwd: '/another-repo' },
        scope: 'local:host'
      },
      {
        repository,
        branch: 'main',
        options: { ...options, ghAccount: { host: 'github.com', user: 'other' } },
        scope: 'local:host'
      },
      {
        repository,
        branch: 'main',
        options: { ...options, env: { GH_TOKEN: 'one' } },
        scope: 'local:host'
      },
      {
        repository,
        branch: 'main',
        options: { ...options, env: { GH_TOKEN: 'two' } },
        scope: 'local:host'
      }
    ]

    const reads = requests.map((request) =>
      detectRepositoryMergeMetadata(
        request.repository,
        request.branch,
        request.options,
        request.scope
      )
    )
    expect(exec).toHaveBeenCalledTimes(requests.length)
    pending.resolve(response(true))
    expect((await Promise.all(reads)).every((value) => value.autoMergeAllowed)).toBe(true)
    for (const request of requests) {
      await expect(
        detectRepositoryMergeMetadata(
          request.repository,
          request.branch,
          request.options,
          request.scope
        )
      ).resolves.toMatchObject({ autoMergeAllowed: true })
    }
    expect(exec).toHaveBeenCalledTimes(requests.length)
  })

  it('shares failed probes and retries unknown settings at the existing short TTL', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(true))
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    const second = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    pending.reject(new Error('offline'))

    expect(await Promise.all([first, second])).toEqual([
      { autoMergeAllowed: null, mergeQueueRequired: null },
      { autoMergeAllowed: null, mergeQueueRequired: null }
    ])
    expect(exec).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('allows a stale successor without letting the older completion replace its cache', async () => {
    vi.useFakeTimers()
    const older = Promise.withResolvers<{ stdout: string }>()
    const newer = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    vi.advanceTimersByTime(60_000)
    const second = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')

    newer.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    older.resolve(response(true))
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: true })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })
})
