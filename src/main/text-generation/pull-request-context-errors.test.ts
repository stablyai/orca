import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPullRequestDraftContext } from './pull-request-context'

type GitExec = Parameters<typeof getPullRequestDraftContext>[0]

afterEach(() => {
  vi.restoreAllMocks()
})

function createContextInput(base = 'main') {
  return {
    base,
    currentTitle: 'Existing title',
    currentBody: 'Existing body',
    currentDraft: false
  }
}

describe('getPullRequestDraftContext error handling', () => {
  // Why: error and validation cases live outside the remote-resolution matrix
  // so each suite stays focused while preserving the same git command coverage.
  it('does not run rebase before collecting PR context', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rebase') {
        throw new Error('Generate must not rebase the live worktree')
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: change\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'M\tREADME.md\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).resolves.toMatchObject({
      branch: 'feature'
    })
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
  })

  it('stops generation when the relevant base fetch fails', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\nstale-fork\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'fetch') {
        if (args[2] !== 'origin') {
          throw new Error(`Fetched unrelated remote: ${args.join(' ')}`)
        }
        throw new Error(
          'Command failed: git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main\nfatal: unable to access origin'
        )
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).rejects.toThrow(
      'Fetch before generating PR details failed: fatal: unable to access origin'
    )
  })

  it('handles newline-heavy remote state and fetch errors without line-array splitting', async () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: `${'\r\n'.repeat(10_000)}origin\r\n`, stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'fetch') {
        throw new Error(
          `Command failed: git fetch\r\n${'remote: progress\r\n'.repeat(10_000)}fatal: unable to access origin\r\n`
        )
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).rejects.toThrow(
      'Fetch before generating PR details failed: fatal: unable to access origin'
    )

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })

  it('returns null without running git when the base is invalid', async () => {
    const execGit = vi.fn<GitExec>()

    await expect(getPullRequestDraftContext(execGit, createContextInput('--main'))).resolves.toBe(
      null
    )
    expect(execGit).not.toHaveBeenCalled()
  })

  it.each(['origin/feature*', 'origin/feature?', 'origin/feature:other', 'origin/feature\u0000'])(
    'does not turn unsafe characters in a qualified base into a fetch refspec (%s)',
    async (base) => {
      const execGit = vi.fn<GitExec>()

      await expect(getPullRequestDraftContext(execGit, createContextInput(base))).resolves.toBe(
        null
      )
      expect(execGit).not.toHaveBeenCalled()
    }
  )

  it('ignores stale tracking refs whose remote name could be parsed as a fetch option', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: '--upload-pack=x\n' }
      }
      if (args[0] === 'show-ref' && args.includes('--verify')) {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        return { stdout: 'abc refs/remotes/--upload-pack=x/main\n' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('main')
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).resolves.toMatchObject({
      branch: 'feature'
    })
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['fetch']), expect.any(Object))
  })

  it('preserves the existing bare HEAD remote-base behavior', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'fetch') {
        return { stdout: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('origin/HEAD')
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(
      getPullRequestDraftContext(execGit, createContextInput('HEAD'))
    ).resolves.toMatchObject({ base: 'HEAD', branch: 'feature' })
    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/HEAD:refs/remotes/origin/HEAD'],
      expect.any(Object)
    )
  })

  it('does not resolve bare HEAD to a nested branch ending in HEAD', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        expect(args).toEqual(['show-ref', '--', 'HEAD'])
        return { stdout: 'abc123 refs/remotes/fork/feature/HEAD\n' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('HEAD')
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(
      getPullRequestDraftContext(execGit, createContextInput('HEAD'))
    ).resolves.toMatchObject({ base: 'HEAD', branch: 'feature' })
    expect(execGit).not.toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'fork', '+refs/heads/feature/HEAD:refs/remotes/fork/feature/HEAD'],
      expect.any(Object)
    )
  })

  it('preserves an explicitly qualified remote HEAD ref', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/origin/HEAD'
          ? { stdout: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch') {
        return { stdout: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('origin/HEAD')
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(
      getPullRequestDraftContext(execGit, createContextInput('origin/HEAD'))
    ).resolves.toMatchObject({ base: 'origin/HEAD', branch: 'feature' })
    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/HEAD:refs/remotes/origin/HEAD'],
      expect.any(Object)
    )
  })
})
