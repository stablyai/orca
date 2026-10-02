import { describe, expect, it, vi } from 'vitest'
import { branchCompare, type GitExec } from './git-handler-ops'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('relay branchCompare', () => {
  it('launches independent Git reads before waiting for any result', async () => {
    const branch = deferred<{ stdout: string; stderr: string }>()
    const head = deferred<{ stdout: string; stderr: string }>()
    const base = deferred<{ stdout: string; stderr: string }>()
    const changes = deferred<Record<string, unknown>[]>()
    const git = vi.fn<GitExec>((args) => {
      if (args[0] === 'branch') {
        return branch.promise
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return head.promise
      }
      if (args[0] === 'rev-parse' && args.includes('--quiet')) {
        return Promise.resolve({ stdout: 'base\n', stderr: '' })
      }
      if (args[0] === 'rev-parse') {
        return base.promise
      }
      if (args[0] === 'merge-base') {
        return Promise.resolve({ stdout: 'merge-base\n', stderr: '' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '2\t1\n', stderr: '' })
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const loadBranchChanges = vi.fn(() => changes.promise)

    const pending = branchCompare(git, '/repo', 'origin/main', loadBranchChanges)
    await Promise.resolve()

    expect(git.mock.calls.map(([args]) => args.join(' ')).slice(0, 3)).toEqual([
      'branch --show-current',
      'rev-parse --verify HEAD',
      'rev-parse --verify --quiet refs/remotes/origin/main^{commit}'
    ])

    branch.resolve({ stdout: 'feature\n', stderr: '' })
    head.resolve({ stdout: 'head\n', stderr: '' })
    base.resolve({ stdout: 'base\n', stderr: '' })
    await vi.waitFor(() => expect(loadBranchChanges).toHaveBeenCalledOnce())
    expect(
      git.mock.calls.some(
        ([args]) => args.join(' ') === 'rev-parse --verify refs/remotes/origin/main'
      )
    ).toBe(true)
    expect(git.mock.calls.some(([args]) => args[0] === 'rev-list')).toBe(true)
    changes.resolve([{ path: 'file.ts' }])

    await expect(pending).resolves.toMatchObject({
      summary: {
        compareRef: 'feature',
        changedFiles: 1,
        commitsAhead: 1,
        commitsBehind: 2,
        status: 'ready'
      }
    })
  })

  it('resolves a local master compare base through origin/master', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--quiet')) {
        expect(args.at(-1)).toBe('refs/remotes/origin/master^{commit}')
        return { stdout: 'origin-master\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return { stdout: 'head\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        expect(args.at(-1)).toBe('refs/remotes/origin/master')
        return { stdout: 'origin-master\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'origin-master\n', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t2\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    await expect(
      branchCompare(git, '/repo', 'master', async () => [
        { path: 'feature-1.ts' },
        { path: 'feature-2.ts' }
      ])
    ).resolves.toMatchObject({
      summary: {
        baseOid: 'origin-master',
        commitsAhead: 2,
        changedFiles: 2,
        status: 'ready'
      }
    })
  })
})
