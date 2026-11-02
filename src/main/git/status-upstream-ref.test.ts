import { describe, expect, it, vi } from 'vitest'
import { resolveGitStatusUpstreamRef } from './status-upstream-ref'

const signal = (): AbortSignal => new AbortController().signal

describe('resolveGitStatusUpstreamRef', () => {
  it('preserves the exact namespace for a slash-containing remote name', async () => {
    const execGit = vi.fn().mockResolvedValue({
      stdout:
        'refs/heads/feature/main\0refs/remotes/team/fork/feature/main\0team/fork/feature/main\n'
    })

    await expect(
      resolveGitStatusUpstreamRef(
        execGit,
        '/repo',
        'refs/heads/feature/main',
        'team/fork/feature/main',
        signal()
      )
    ).resolves.toBe('refs/remotes/team/fork/feature/main')
    expect(execGit).toHaveBeenCalledWith(
      [
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)',
        '--count=1',
        'refs/heads/feature/main'
      ],
      '/repo',
      expect.any(AbortSignal)
    )
  })

  it('returns a slash-named local upstream for the binding validator to reject', async () => {
    const execGit = vi.fn().mockResolvedValue({
      stdout: 'refs/heads/feature/topic\0refs/heads/feature/base\0feature/base\n'
    })

    await expect(
      resolveGitStatusUpstreamRef(
        execGit,
        '/repo',
        'refs/heads/feature/topic',
        'feature/base',
        signal()
      )
    ).resolves.toBe('refs/heads/feature/base')
  })

  it('returns a missing custom refspec destination from branch configuration', async () => {
    const execGit = vi.fn().mockResolvedValue({
      stdout: 'refs/heads/feature/main\0refs/custom/origin/main\0custom/origin/main\n'
    })

    await expect(
      resolveGitStatusUpstreamRef(
        execGit,
        '/repo',
        'refs/heads/feature/main',
        'custom/origin/main',
        signal()
      )
    ).resolves.toBe('refs/custom/origin/main')
    expect(execGit).toHaveBeenCalledOnce()
  })

  it('resolves an accepted effective upstream override explicitly', async () => {
    const execGit = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'refs/heads/feature/prompts\0refs/remotes/origin/main\0origin/main\n'
      })
      .mockResolvedValueOnce({
        stdout: '--end-of-options\nrefs/remotes/origin/feature/prompts\n'
      })

    await expect(
      resolveGitStatusUpstreamRef(
        execGit,
        '/repo',
        'refs/heads/feature/prompts',
        'origin/feature/prompts',
        signal()
      )
    ).resolves.toBe('refs/remotes/origin/feature/prompts')
    expect(execGit).toHaveBeenNthCalledWith(
      2,
      ['rev-parse', '--symbolic-full-name', '--end-of-options', 'origin/feature/prompts'],
      '/repo',
      expect.any(AbortSignal)
    )
  })

  it('fails safe when an effective override is ambiguous', async () => {
    const execGit = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'refs/heads/feature/main\0refs/remotes/origin/main\0origin/main\n'
      })
      .mockResolvedValueOnce({
        stdout: 'refs/heads/origin/feature/main\nrefs/remotes/origin/feature/main\n'
      })

    await expect(
      resolveGitStatusUpstreamRef(
        execGit,
        '/repo',
        'refs/heads/feature/main',
        'origin/feature/main',
        signal()
      )
    ).resolves.toBeUndefined()
  })

  it('rejects a stale status whose accepted branch no longer exists', async () => {
    const execGit = vi.fn().mockResolvedValue({ stdout: '' })

    await expect(
      resolveGitStatusUpstreamRef(execGit, '/repo', 'refs/heads/old', 'origin/old', signal())
    ).resolves.toBeUndefined()
  })
})
