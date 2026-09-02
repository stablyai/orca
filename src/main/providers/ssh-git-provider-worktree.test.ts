import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  waitForRequestCount,
  type MockMultiplexer
} from './ssh-git-provider-test-harness'

function methodNotFound(method: string): Error & { code: number } {
  return Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

const CLEAN_STATUS = { entries: [], conflictOperation: 'unknown' }

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('listWorktrees sends git.listWorktrees request', async () => {
    const worktrees = [
      {
        path: '/home/user/repo',
        head: 'abc123',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ]
    mux.request.mockResolvedValue(worktrees)

    const controller = new AbortController()
    const result = await provider.listWorktrees('/home/user/repo', { signal: controller.signal })
    expect(mux.request).toHaveBeenCalledWith(
      'git.listWorktrees',
      { repoPath: '/home/user/repo' },
      { signal: controller.signal }
    )
    expect(result).toEqual(worktrees)
  })

  it('addWorktree sends git.addWorktree request', async () => {
    await provider.addWorktree('/home/user/repo', 'feature', '/home/user/feat', {
      base: 'main',
      noCheckout: true
    })
    expect(mux.request).toHaveBeenCalledWith('git.addWorktree', {
      repoPath: '/home/user/repo',
      branchName: 'feature',
      targetDir: '/home/user/feat',
      base: 'main',
      noCheckout: true
    })
  })

  it('removeWorktree sends git.removeWorktree request', async () => {
    await provider.removeWorktree('/home/user/feat', true)
    expect(mux.request).toHaveBeenCalledWith('git.removeWorktree', {
      worktreePath: '/home/user/feat',
      force: true
    })
  })

  it('worktreeIsClean sends git.worktreeIsClean request', async () => {
    const cleanResult = { clean: false, stdout: '?? scratch.txt\n' }
    mux.request.mockResolvedValue(cleanResult)

    const result = await provider.worktreeIsClean('/home/user/feat')

    expect(mux.request).toHaveBeenCalledWith('git.worktreeIsClean', {
      worktreePath: '/home/user/feat'
    })
    expect(result).toEqual(cleanResult)
  })

  it('keeps supported clean checks on the preferred relay RPC', async () => {
    let resolveProbe!: (result: { clean: boolean }) => void
    let resolveRemaining!: (result: { clean: boolean }) => void
    const probe = new Promise<{ clean: boolean }>((resolve) => {
      resolveProbe = resolve
    })
    const remaining = new Promise<{ clean: boolean }>((resolve) => {
      resolveRemaining = resolve
    })
    let preferredRequestCount = 0
    mux.request.mockImplementation((method) => {
      expect(method).toBe('git.worktreeIsClean')
      preferredRequestCount += 1
      return preferredRequestCount === 1 ? probe : remaining
    })
    const checks = Array.from({ length: 10 }, (_, index) =>
      provider.worktreeIsClean(`/repo/worktree-${index}`)
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledOnce()
    resolveProbe({ clean: true })
    await waitForRequestCount(mux.request, 10)
    expect(mux.request).toHaveBeenCalledTimes(10)
    resolveRemaining({ clean: true })
    await expect(Promise.all(checks)).resolves.toEqual(
      Array.from({ length: 10 }, () => ({ clean: true }))
    )
    expect(
      mux.request.mock.calls.filter(([method]) => method === 'git.worktreeIsClean')
    ).toHaveLength(10)
    expect(mux.request.mock.calls.some(([method]) => method === 'git.status')).toBe(false)
  })

  it('worktreeIsClean can ignore untracked files', async () => {
    const cleanResult = { clean: true }
    mux.request.mockResolvedValue(cleanResult)

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(mux.request).toHaveBeenCalledWith('git.worktreeIsClean', {
      worktreePath: '/home/user/feat',
      includeUntracked: false
    })
    expect(result).toEqual(cleanResult)
  })

  it('worktreeIsClean filters untracked stdout when old relays ignore the option', async () => {
    mux.request.mockResolvedValue({ clean: false, stdout: '?? scratch.txt\n' })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: true })
  })

  it('worktreeIsClean keeps dirty results without stdout dirty for tracked-only checks', async () => {
    mux.request.mockResolvedValue({ clean: false })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: false })
  })

  it('refreshLocalBaseRefForWorktreeCreate sends the narrow refresh request', async () => {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath: '/home/user/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/home/user/repo'
    })

    expect(mux.request).toHaveBeenCalledWith('git.refreshLocalBaseRefForWorktreeCreate', {
      repoPath: '/home/user/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/home/user/repo'
    })
  })

  it('worktreeIsClean falls back to git.status for old relays', async () => {
    mux.request.mockRejectedValueOnce(methodNotFound('git.worktreeIsClean')).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await provider.worktreeIsClean('/home/user/feat')

      expect(mux.request).toHaveBeenNthCalledWith(1, 'git.worktreeIsClean', {
        worktreePath: '/home/user/feat'
      })
      expect(mux.request).toHaveBeenNthCalledWith(
        2,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
      expect(result).toEqual({ clean: false, stdout: 'untracked untracked: scratch.txt' })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('probes an old relay once across sequential clean checks', async () => {
    mux.request.mockImplementation(async (method) => {
      if (method === 'git.worktreeIsClean') {
        throw methodNotFound(method)
      }
      return CLEAN_STATUS
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worktreePaths = Array.from({ length: 10 }, (_, index) => `/repo/worktree-${index}`)

    try {
      for (const worktreePath of worktreePaths) {
        await expect(provider.worktreeIsClean(worktreePath)).resolves.toEqual({ clean: true })
      }

      expect(
        mux.request.mock.calls.filter(([method]) => method === 'git.worktreeIsClean')
      ).toHaveLength(1)
      expect(mux.request.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(10)
      expect(mux.request).toHaveBeenCalledTimes(11)
      expect(warnSpy).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('shares one old-relay probe across concurrent clean checks', async () => {
    let rejectProbe!: (error: Error) => void
    const probe = new Promise((_resolve, reject) => {
      rejectProbe = reject
    })
    mux.request.mockImplementation((method) => {
      if (method === 'git.worktreeIsClean') {
        return probe
      }
      return Promise.resolve(CLEAN_STATUS)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const checks = Array.from({ length: 10 }, (_, index) =>
      provider.worktreeIsClean(`/repo/worktree-${index}`)
    )

    try {
      await waitForRequestCount(mux.request, 1)
      rejectProbe(methodNotFound('git.worktreeIsClean'))
      await expect(Promise.all(checks)).resolves.toEqual(
        Array.from({ length: 10 }, () => ({ clean: true }))
      )

      expect(
        mux.request.mock.calls.filter(([method]) => method === 'git.worktreeIsClean')
      ).toHaveLength(1)
      expect(mux.request.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(10)
      expect(mux.request).toHaveBeenCalledTimes(11)
      expect(warnSpy).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('retries the preferred clean RPC after a transport failure', async () => {
    const transportError = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32602
    })
    mux.request.mockRejectedValueOnce(transportError).mockResolvedValueOnce({ clean: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(provider.worktreeIsClean('/repo/first')).rejects.toBe(transportError)
      await expect(provider.worktreeIsClean('/repo/second')).resolves.toEqual({ clean: true })
      expect(mux.request.mock.calls.map(([method]) => method)).toEqual([
        'git.worktreeIsClean',
        'git.worktreeIsClean'
      ])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('lets concurrent waiters retry after a transient probe failure', async () => {
    const transportError = new Error('connection closed')
    let rejectProbe!: (error: Error) => void
    let resolveRetries!: (result: { clean: boolean }) => void
    const probe = new Promise((_resolve, reject) => {
      rejectProbe = reject
    })
    const retries = new Promise<{ clean: boolean }>((resolve) => {
      resolveRetries = resolve
    })
    let preferredRequestCount = 0
    mux.request.mockImplementation((method) => {
      expect(method).toBe('git.worktreeIsClean')
      preferredRequestCount += 1
      return preferredRequestCount === 1 ? probe : retries
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const checks = Array.from({ length: 3 }, (_, index) =>
      provider.worktreeIsClean(`/repo/worktree-${index}`)
    )
    const settledChecks = Promise.allSettled(checks)

    try {
      await waitForRequestCount(mux.request, 1)
      rejectProbe(transportError)
      await waitForRequestCount(mux.request, 3)
      resolveRetries({ clean: true })

      const results = await settledChecks
      expect(results[0]).toEqual({ status: 'rejected', reason: transportError })
      expect(results.slice(1)).toEqual([
        { status: 'fulfilled', value: { clean: true } },
        { status: 'fulfilled', value: { clean: true } }
      ])
      await expect(provider.worktreeIsClean('/repo/later')).resolves.toEqual({ clean: true })
      expect(mux.request).toHaveBeenCalledTimes(4)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('re-probes clean support after the provider is replaced', async () => {
    mux.request.mockImplementation(async (method) => {
      if (method === 'git.worktreeIsClean') {
        throw methodNotFound(method)
      }
      return CLEAN_STATUS
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(provider.worktreeIsClean('/repo/first')).resolves.toEqual({ clean: true })
      const replacement = new SshGitProvider('conn-1', mux as never)
      await expect(replacement.worktreeIsClean('/repo/second')).resolves.toEqual({ clean: true })

      expect(
        mux.request.mock.calls.filter(([method]) => method === 'git.worktreeIsClean')
      ).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('worktreeIsClean filters untracked entries in old-relay fallback', async () => {
    mux.request.mockImplementation(async (method) => {
      if (method === 'git.worktreeIsClean') {
        throw methodNotFound(method)
      }
      return {
        entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
        conflictOperation: 'unknown'
      }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(provider.worktreeIsClean('/home/user/feat')).resolves.toEqual({
        clean: false,
        stdout: 'untracked untracked: scratch.txt'
      })
      await expect(
        provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })
      ).resolves.toEqual({ clean: true })
      expect(mux.request).toHaveBeenNthCalledWith(
        3,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
      expect(
        mux.request.mock.calls.filter(([method]) => method === 'git.worktreeIsClean')
      ).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('renameCurrentBranch sends the narrow branch-rename request', async () => {
    await provider.renameCurrentBranch('/home/user/feat', 'you/fix-auth')
    expect(mux.request).toHaveBeenCalledWith('git.renameCurrentBranch', {
      worktreePath: '/home/user/feat',
      newBranch: 'you/fix-auth'
    })
  })

  it('forceDeletePreservedBranch sends the preserved-branch delete request', async () => {
    await provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    expect(mux.request).toHaveBeenCalledWith('git.forceDeletePreservedBranch', {
      repoPath: '/home/user/repo',
      branchName: 'you/fix-auth',
      expectedHead: 'abc123'
    })
  })

  it('forceDeletePreservedBranch maps old relays to the reconnect message', async () => {
    mux.request.mockRejectedValueOnce(methodNotFound('git.forceDeletePreservedBranch'))

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot delete preserved branches. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('forceDeletePreservedBranch rethrows non-method-not-found errors', async () => {
    const error = new Error('remote update-ref failed')
    mux.request.mockRejectedValueOnce(error)

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toBe(error)
  })

  it('markRemoteOrcaCreated sends the narrow provenance-marker request', async () => {
    await provider.markRemoteOrcaCreated('/home/user/repo', 'pr-contributor-orca')
    expect(mux.request).toHaveBeenCalledWith('git.markRemoteOrcaCreated', {
      repoPath: '/home/user/repo',
      remoteName: 'pr-contributor-orca'
    })
  })

  it('markRemoteOrcaCreated degrades to a one-time warning for an older relay', async () => {
    mux.request.mockRejectedValue(methodNotFound('git.markRemoteOrcaCreated'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(
        provider.markRemoteOrcaCreated('/home/user/repo', 'pr-contributor-orca')
      ).resolves.toBeUndefined()
      await expect(
        provider.markRemoteOrcaCreated('/home/user/repo', 'pr-contributor-orca')
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('markRemoteOrcaCreated rethrows non-method-not-found errors', async () => {
    const error = new Error('remote config write failed')
    mux.request.mockRejectedValueOnce(error)

    await expect(
      provider.markRemoteOrcaCreated('/home/user/repo', 'pr-contributor-orca')
    ).rejects.toBe(error)
  })
})
