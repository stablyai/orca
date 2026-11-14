import { describe, expect, it, vi } from 'vitest'
import { resolveGitStatusUpstreamRef } from './status-upstream-ref'

const signal = (): AbortSignal => new AbortController().signal

describe('resolveGitStatusUpstreamRef', () => {
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
})
