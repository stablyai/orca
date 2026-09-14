// Why: PR context generation depends on command order across remote-state
// variants; keeping the table of git command mocks together makes regressions
// easier to audit than splitting the suite by helper.
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

describe('getPullRequestDraftContext', () => {
  it('fetches the resolved remote base before collecting PR context without mutating HEAD', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return {
          stdout: 'abc refs/remotes/origin/main\n' + 'def refs/remotes/upstream/main\n',
          stderr: ''
        }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature/pr-details\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: summarize branch\n', stderr: '' }
      }
      if (args[0] === 'diff' && args[1] === '--name-status') {
        return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'diff --git a/src/file.ts b/src/file.ts\n+change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    const context = await getPullRequestDraftContext(execGit, createContextInput())

    expect(context).toMatchObject({
      branch: 'feature/pr-details',
      base: 'main',
      branchChangedByPreparation: false,
      commitSummary: '- feat: summarize branch',
      changeSummary: 'M\tsrc/file.ts'
    })
    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      expect.any(Object)
    )
    expect(execGit).toHaveBeenCalledWith(
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/origin/main'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 })
    )
    expect(execGit).toHaveBeenCalledWith(
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/upstream/main'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 })
    )
    const exactRefCalls = execGit.mock.calls.filter(([args]) => args[0] === 'show-ref')
    expect(exactRefCalls).toHaveLength(2)
    expect(exactRefCalls.every(([, options]) => options?.timeoutMs === undefined)).toBe(true)
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
    expect(execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['rev-parse']),
      expect.anything()
    )
    expect(execGit).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD'], expect.any(Object))

    const commandNames = execGit.mock.calls.map(([args]) => args[0])
    expect(commandNames.indexOf('fetch')).toBeLessThan(commandNames.indexOf('merge-base'))
  })

  it('fetches a configured preferred remote without a suffix scan when its ref is absent', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature/pr-details\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: summarize branch\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'M\tREADME.md\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await getPullRequestDraftContext(execGit, createContextInput())

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      expect.any(Object)
    )
    expect(execGit.mock.calls.some(([args]) => args.join(' ') === 'show-ref -- main')).toBe(false)
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
  })

  it('does not fetch unrelated fork remotes before generating PR context', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        expect(args).not.toContain('--all')
        expect(args[2]).toBe('origin')
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nstale-fork\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature/pr-details\n', stderr: '' }
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
      branch: 'feature/pr-details'
    })

    expect(execGit).not.toHaveBeenCalledWith(['fetch', '--all', '--prune'], expect.any(Object))
    expect(execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['stale-fork']),
      expect.any(Object)
    )
  })

  it('does not guess between multiple non-preferred remote bases for a bare base name', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        throw new Error(`Unexpected fetch: ${args.join(' ')}`)
      }
      if (args[0] === 'remote') {
        return { stdout: 'contributor-a\ncontributor-b\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('main')
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

    await getPullRequestDraftContext(execGit, createContextInput())

    expect(execGit.mock.calls.filter(([args]) => args[0] === 'for-each-ref')).toHaveLength(0)
    const showRefCalls = execGit.mock.calls.filter(([args]) => args[0] === 'show-ref')
    const exactRefs = showRefCalls
      .filter(([args]) => args.includes('--verify'))
      .map(([args]) => args.at(-1))
    expect(exactRefs).toEqual(
      expect.arrayContaining([
        'refs/remotes/origin/main',
        'refs/remotes/upstream/main',
        'refs/remotes/contributor-a/main',
        'refs/remotes/contributor-b/main'
      ])
    )
    expect(showRefCalls.some(([args]) => args.join(' ') === 'show-ref -- main')).toBe(true)

    expect(execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['contributor-a']),
      expect.any(Object)
    )
    expect(execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['contributor-b']),
      expect.any(Object)
    )
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
  })

  it('does not choose another remote when an exact probe is inconclusive', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'first\nsecond\n' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('remote probe failed'), { code: 128 })
      }
      if (args[0] === 'fetch') {
        throw new Error(`Unexpected fetch: ${args.join(' ')}`)
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

  it('bounds exact remote-ref probe concurrency for a large remote list', async () => {
    const remoteNames = Array.from({ length: 20 }, (_, index) => `remote-${index}`)
    let exactProbeCount = 0
    let activeProbes = 0
    let maxActiveProbes = 0
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: `${remoteNames.join('\n')}\n`, stderr: '' }
      }
      if (args[0] === 'show-ref') {
        if (args.some((arg) => arg.startsWith('refs/remotes/'))) {
          exactProbeCount += 1
          activeProbes += 1
          maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
          await new Promise((resolve) => setTimeout(resolve, 0))
          activeProbes -= 1
        }
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).resolves.toMatchObject({
      branch: 'feature'
    })

    expect(exactProbeCount).toBe(22)
    // Equality, not a ceiling: 22 candidates saturate the pool, so a regression
    // to serial probing has to fail here.
    expect(maxActiveProbes).toBe(8)
  })

  it('resolves a unique slash-containing remote with an exact probe', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'foo/bar\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/foo/bar/feature/fix'
          ? { stdout: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('foo/bar/feature/fix')
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(
      getPullRequestDraftContext(execGit, createContextInput('feature/fix'))
    ).resolves.toMatchObject({ branchChangedByPreparation: false })

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'foo/bar', '+refs/heads/feature/fix:refs/remotes/foo/bar/feature/fix'],
      expect.any(Object)
    )
    expect(execGit.mock.calls.filter(([args]) => args[0] === 'for-each-ref')).toHaveLength(0)
  })

  it('preserves Git-valid punctuation in configured remote names', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'team@corp\n' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/team@corp/main'
          ? { stdout: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch' || args[0] === 'branch') {
        return { stdout: '' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('team@corp/main')
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await getPullRequestDraftContext(execGit, createContextInput())

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'team@corp', '+refs/heads/main:refs/remotes/team@corp/main'],
      expect.any(Object)
    )
  })

  it('resolves a unique unconfigured remote suffix with a bounded show-ref fallback', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        return { stdout: 'abc123 refs/remotes/orphan/main\n' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('orphan/main')
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

    expect(execGit).toHaveBeenCalledWith(['show-ref', '--', 'main'], expect.any(Object))
    expect(execGit).toHaveBeenCalledWith(
      ['show-ref', '--', 'main'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 })
    )
    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'orphan', '+refs/heads/main:refs/remotes/orphan/main'],
      expect.any(Object)
    )
  })

  it('does not guess when the suffix fallback finds multiple remotes', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      if (args[0] === 'show-ref') {
        return {
          stdout: 'abc123 refs/remotes/orphan-a/main\nabc123 refs/remotes/orphan-b/main\n'
        }
      }
      if (args[0] === 'fetch') {
        throw new Error(`Unexpected fetch: ${args.join(' ')}`)
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

  it('treats a suffix fallback overflow or transport error as no match', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'show-ref') {
        if (args.some((arg) => arg.startsWith('refs/remotes/'))) {
          throw Object.assign(new Error('missing exact ref'), { code: 1 })
        }
        throw new Error('git stdout exceeded maxBuffer')
      }
      if (args[0] === 'fetch') {
        throw new Error(`Unexpected fetch: ${args.join(' ')}`)
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
    expect(execGit).toHaveBeenCalledWith(['show-ref', '--', 'main'], expect.any(Object))
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['fetch']), expect.any(Object))
  })

  it('reports no branch change because PR context preparation is read-only', async () => {
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

    const context = await getPullRequestDraftContext(execGit, createContextInput())

    expect(context?.branchChangedByPreparation).toBe(false)
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
    expect(execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['rev-parse']),
      expect.anything()
    )
  })

  it('keeps a remote-qualified base when the selected base includes the remote', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
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
      return { stdout: '', stderr: '' }
    })

    await getPullRequestDraftContext(execGit, createContextInput('upstream/main'))

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'upstream', '+refs/heads/main:refs/remotes/upstream/main'],
      expect.any(Object)
    )
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['rebase']), expect.anything())
    expect(execGit).toHaveBeenCalledWith(
      ['merge-base', 'upstream/main', 'HEAD'],
      expect.any(Object)
    )
  })

  it('preserves a legal branch whose final component is HEAD', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/origin/feature/HEAD'
          ? { stdout: '', stderr: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature/current\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('origin/feature/HEAD')
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await getPullRequestDraftContext(execGit, createContextInput('feature/HEAD'))

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/feature/HEAD:refs/remotes/origin/feature/HEAD'],
      expect.any(Object)
    )
  })

  it('retains exact-ref precedence when many other remotes share the suffix', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\nfirst\nsecond\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/orphan/main'
          ? { stdout: '', stderr: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch' || args[0] === 'branch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('orphan/main')
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await getPullRequestDraftContext(execGit, createContextInput('orphan/main'))

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'orphan', '+refs/heads/main:refs/remotes/orphan/main'],
      expect.any(Object)
    )
  })

  it('retains preferred origin precedence when its remote is not configured', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return args.at(-1) === 'refs/remotes/origin/main'
          ? { stdout: '', stderr: '' }
          : Promise.reject(Object.assign(new Error('missing exact ref'), { code: 1 }))
      }
      if (args[0] === 'fetch' || args[0] === 'branch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        expect(args[1]).toBe('origin/main')
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log' || args[0] === 'diff') {
        return { stdout: 'change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await getPullRequestDraftContext(execGit, createContextInput())

    expect(execGit).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      expect.any(Object)
    )
    expect(
      execGit.mock.calls.filter(([args]) => args[0] === 'show-ref' && args.includes('--verify'))
    ).toHaveLength(3)
    expect(execGit.mock.calls.filter(([args]) => args[0] === 'for-each-ref')).toHaveLength(0)
  })
})
