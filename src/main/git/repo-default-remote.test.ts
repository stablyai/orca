import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { getDefaultRemote } from './repo'

describe('getDefaultRemote', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('prefers the configured remote for the resolved default branch', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\n' }
      }
      if (argv[0] === 'config') {
        return { stdout: 'upstream\n' }
      }
      throw new Error('unexpected command')
    })

    await expect(getDefaultRemote('/repo')).resolves.toBe('upstream')
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['config', '--get', 'branch.main.remote'],
      { cwd: '/repo' }
    )
  })

  it.each([
    ['origin\nupstream\n', 'origin'],
    ['company\n', 'company']
  ])('falls back from unresolved defaults for remotes %j', async (stdout, expected) => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'remote') {
        return { stdout }
      }
      throw new Error('missing ref')
    })

    await expect(getDefaultRemote('/repo')).resolves.toBe(expected)
  })

  it.each([
    ['', 'Repo has no configured git remotes.'],
    [
      'upstream\nfork\n',
      'Repo has multiple remotes (upstream, fork) and no default is configured. Set branch.<default>.remote.'
    ]
  ])('preserves the exact ambiguous-remote error for %j', async (stdout, message) => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'remote') {
        return { stdout }
      }
      throw new Error('missing ref')
    })

    await expect(getDefaultRemote('/repo')).rejects.toThrow(message)
  })

  it('normalizes a non-Error remote rejection', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('missing ref'))
    gitExecFileAsyncMock.mockRejectedValueOnce('transport failed')

    await expect(getDefaultRemote('/repo')).rejects.toThrow(
      'Failed to resolve default remote for repo.'
    )
  })

  it('keeps configured branch precedence when a remote list is already available', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\n' }
      }
      if (argv[0] === 'config') {
        return { stdout: 'upstream\n' }
      }
      throw new Error('unexpected command')
    })

    await expect(getDefaultRemote('/repo', {}, ['origin', 'upstream'])).resolves.toBe('upstream')
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'remote')).toBe(false)
  })

  it.each([
    [['origin', 'upstream'], 'origin'],
    [['company'], 'company']
  ])('reuses known remotes %j when no default ref resolves', async (remotes, expected) => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('missing ref'))

    await expect(getDefaultRemote('/repo', {}, remotes)).resolves.toBe(expected)
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'remote')).toBe(false)
  })

  it.each([
    [[], 'Repo has no configured git remotes.'],
    [
      ['upstream', 'fork'],
      'Repo has multiple remotes (upstream, fork) and no default is configured. Set branch.<default>.remote.'
    ]
  ])('preserves errors for known remotes %j', async (remotes, message) => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('missing ref'))

    await expect(getDefaultRemote('/repo', {}, remotes)).rejects.toThrow(message)
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'remote')).toBe(false)
  })
})
