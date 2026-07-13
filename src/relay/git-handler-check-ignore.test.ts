import { describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { checkIgnoredPathsOp } from './git-handler-check-ignore'
import { GIT_CHECK_IGNORE_TIMEOUT_MS } from '../shared/git-check-ignore-stdio'

describe('checkIgnoredPathsOp', () => {
  it('passes exact paths over one bounded NUL-delimited stdin invocation', async () => {
    const git = vi.fn<GitExec>().mockResolvedValue({
      stdout: 'dist/bundle.js\0line\nbreak.txt\0',
      stderr: ''
    })

    await expect(
      checkIgnoredPathsOp(git, {
        worktreePath: '/repo',
        paths: ['dist/bundle.js', 'line\nbreak.txt', 'src/index.ts']
      })
    ).resolves.toEqual(['dist/bundle.js', 'line\nbreak.txt'])

    expect(git).toHaveBeenCalledWith(
      ['-c', 'core.quotePath=false', 'check-ignore', '-z', '--stdin'],
      '/repo',
      {
        stdin: 'dist/bundle.js\0line\nbreak.txt\0src/index.ts\0',
        timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
      }
    )
  })

  it('treats git exit code 1 as no ignored paths', async () => {
    const noMatches = Object.assign(new Error('no ignored paths'), {
      code: 1,
      stdout: ''
    })
    const git = vi.fn<GitExec>().mockRejectedValue(noMatches)

    await expect(
      checkIgnoredPathsOp(git, {
        worktreePath: '/repo',
        paths: ['src/index.ts']
      })
    ).resolves.toEqual([])
  })
})
