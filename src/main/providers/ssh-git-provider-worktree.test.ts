import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'

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
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
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

  it('worktreeIsClean filters untracked entries in old-relay fallback', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(
        provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })
      ).resolves.toEqual({ clean: true })
      expect(mux.request).toHaveBeenNthCalledWith(
        2,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
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
    const methodNotFound = Object.assign(
      new Error('Method not found: git.forceDeletePreservedBranch'),
      { code: -32601 }
    )
    mux.request.mockRejectedValueOnce(methodNotFound)

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
})
