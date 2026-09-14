import { describe, expect, it, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('returns the connectionId', () => {
    expect(provider.getConnectionId()).toBe('conn-1')
  })

  it('getStatus sends git.status request', async () => {
    const statusResult = {
      entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown',
      didHitLimit: true,
      statusLength: 1_001
    }
    mux.request.mockResolvedValue(statusResult)

    const result = await provider.getStatus('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith(
      'git.status',
      { worktreePath: '/home/user/repo' },
      { signal: expect.any(AbortSignal) }
    )
    expect(result).toEqual(statusResult)
  })

  it('getStatus forwards includeIgnored only when requested', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown', ignoredPaths: ['dist/'] }
    mux.request.mockResolvedValue(statusResult)

    await provider.getStatus('/home/user/repo', { includeIgnored: true })
    await provider.getStatus('/home/user/repo', { includeIgnored: false })

    expect(mux.request).toHaveBeenNthCalledWith(
      1,
      'git.status',
      {
        worktreePath: '/home/user/repo',
        includeIgnored: true
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(mux.request).toHaveBeenNthCalledWith(
      2,
      'git.status',
      { worktreePath: '/home/user/repo' },
      { signal: expect.any(AbortSignal) }
    )
  })

  it('getStatus forwards a false line-stats request', async () => {
    mux.request.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })

    await provider.getStatus('/home/user/repo', { includeLineStats: false })

    expect(mux.request).toHaveBeenCalledWith(
      'git.status',
      { worktreePath: '/home/user/repo', includeLineStats: false },
      { signal: expect.any(AbortSignal) }
    )
  })

  it('getStatus forwards upstream-negative-cache bypass only when requested', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    await provider.getStatus('/home/user/repo', { bypassEffectiveUpstreamNegativeCache: true })
    await provider.getStatus('/home/user/repo', { bypassEffectiveUpstreamNegativeCache: false })

    expect(mux.request).toHaveBeenNthCalledWith(
      1,
      'git.status',
      {
        worktreePath: '/home/user/repo',
        bypassEffectiveUpstreamNegativeCache: true
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(mux.request).toHaveBeenNthCalledWith(
      2,
      'git.status',
      { worktreePath: '/home/user/repo' },
      { signal: expect.any(AbortSignal) }
    )
  })

  it('getStatus forwards line-stat reuse and cancellation to the relay', async () => {
    const controller = new AbortController()
    mux.request.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })

    await provider.getStatus('/home/user/repo', {
      reuseLineStats: true,
      signal: controller.signal
    })

    expect(mux.request).toHaveBeenCalledWith(
      'git.status',
      { worktreePath: '/home/user/repo', reuseLineStats: true },
      { signal: expect.any(AbortSignal) }
    )
    expect(mux.request.mock.calls[0][2].signal).not.toBe(controller.signal)
  })

  it('getSubmoduleStatus sends git.submoduleStatus request', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    const result = await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')

    expect(mux.request).toHaveBeenCalledWith('git.submoduleStatus', {
      worktreePath: '/home/user/repo',
      submodulePath: 'vendor/lib',
      area: 'unstaged'
    })
    expect(result).toEqual(statusResult)
  })

  it('getSubmoduleStatus forwards the requested source-control area', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib', 'staged')

    expect(mux.request).toHaveBeenCalledWith('git.submoduleStatus', {
      worktreePath: '/home/user/repo',
      submodulePath: 'vendor/lib',
      area: 'staged'
    })
  })

  it('reports an actionable reconnect message when the relay lacks submodule status', async () => {
    const methodNotFound = new Error('Method not found: git.submoduleStatus') as Error & {
      code?: number
    }
    methodNotFound.code = -32601
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')).rejects.toThrow(
      'SSH submodule diff support is unavailable on this relay. Reconnect the SSH target to update Orca on the host, then try again.'
    )
  })

  it('rethrows non-method-not-found submodule status errors unchanged', async () => {
    mux.request.mockRejectedValueOnce(new Error('fatal: not a submodule'))

    await expect(provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')).rejects.toThrow(
      'fatal: not a submodule'
    )
  })

  it('checkIgnoredPaths sends git.checkIgnored request', async () => {
    mux.request.mockResolvedValue(['dist/bundle.js'])

    const result = await provider.checkIgnoredPaths('/home/user/repo', ['dist/bundle.js'])

    expect(mux.request).toHaveBeenCalledWith('git.checkIgnored', {
      worktreePath: '/home/user/repo',
      paths: ['dist/bundle.js']
    })
    expect(result).toEqual(['dist/bundle.js'])
  })

  it('getHistory sends git.history request', async () => {
    const historyResult = {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    }
    mux.request.mockResolvedValue(historyResult)

    const result = await provider.getHistory('/home/user/repo', {
      limit: 25,
      baseRef: 'origin/main'
    })

    expect(mux.request).toHaveBeenCalledWith('git.history', {
      worktreePath: '/home/user/repo',
      limit: 25,
      baseRef: 'origin/main'
    })
    expect(result).toEqual(historyResult)
  })

  it('detectConflictOperation sends git.conflictOperation request', async () => {
    mux.request.mockResolvedValue('rebase')
    const result = await provider.detectConflictOperation('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.conflictOperation', {
      worktreePath: '/home/user/repo'
    })
    expect(result).toBe('rebase')
  })

  it('getBranchCompare sends git.branchCompare request', async () => {
    const compareResult = { summary: { ahead: 2, behind: 0 }, entries: [] }
    mux.request.mockResolvedValue(compareResult)

    const result = await provider.getBranchCompare('/home/user/repo', 'main', {
      admissionTier: 'background'
    })
    expect(mux.request).toHaveBeenCalledWith('git.branchCompare', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      admissionTier: 'background'
    })
    expect(result).toEqual(compareResult)
  })

  it('isGitRepo always returns true for remote paths', () => {
    expect(provider.isGitRepo('/any/path')).toBe(true)
  })
})
