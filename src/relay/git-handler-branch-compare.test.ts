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

    expect(git.mock.calls.map(([args]) => args.join(' '))).toEqual([
      'branch --show-current',
      'rev-parse --verify HEAD',
      'rev-parse --verify origin/main'
    ])

    branch.resolve({ stdout: 'feature\n', stderr: '' })
    head.resolve({ stdout: 'head\n', stderr: '' })
    base.resolve({ stdout: 'base\n', stderr: '' })
    await vi.waitFor(() => expect(loadBranchChanges).toHaveBeenCalledOnce())
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
})
