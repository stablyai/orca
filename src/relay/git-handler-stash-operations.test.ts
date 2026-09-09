import { describe, expect, it, vi } from 'vitest'
import { GitHandlerStashOperations } from './git-handler-stash-operations'
import { registerGitHandlers } from './git-handler-registration'
import { createMockDispatcher } from './git-handler-test-setup'
import type { GitHandlerOperationHost } from './git-handler-operation-context'
import type { GitHandlerOperationSet } from './git-handler-operation-set'

const OID = 'a'.repeat(40)

function operationWith(git: GitHandlerOperationHost['git']): GitHandlerStashOperations {
  const runWithGitReadCacheClear: GitHandlerOperationHost['runWithGitReadCacheClear'] = (run) =>
    run()
  const host = {
    git,
    gitBuffer: vi.fn(),
    spawnClone: vi.fn(),
    clearGitMutationReadCaches: vi.fn(),
    runWithGitReadCacheClear,
    maybeStreamResponse: (value: unknown) => value,
    gitDiffReadDedupe: {} as GitHandlerOperationHost['gitDiffReadDedupe'],
    gitCapabilities: {} as GitHandlerOperationHost['gitCapabilities'],
    submodulePathsCache: {} as GitHandlerOperationHost['submodulePathsCache'],
    watcherRegistry: undefined
  } satisfies GitHandlerOperationHost
  return new GitHandlerStashOperations(host)
}

describe('SSH relay stash operations', () => {
  it('forwards read cancellation and rejects invalid paths and refs before Git', async () => {
    const git = vi.fn<GitHandlerOperationHost['git']>().mockResolvedValue({ stdout: '', stderr: '' })
    const operation = operationWith(git)
    const controller = new AbortController()

    await operation.list({ worktreePath: '/repo' }, { signal: controller.signal } as never)
    expect(git).toHaveBeenCalledWith(expect.any(Array), '/repo', { signal: controller.signal })
    await expect(
      operation.files({ worktreePath: '/repo', ref: '--help' }, {} as never)
    ).rejects.toThrow('invalid_stash_revision')
    await expect(
      operation.list({ worktreePath: 'relative/repo' }, {} as never)
    ).rejects.toThrow('invalid_worktree_path')
  })

  it('refuses a reindexed stash before applying it', async () => {
    const git = vi.fn<GitHandlerOperationHost['git']>().mockResolvedValue({
      stdout: `${'b'.repeat(40)}\n`,
      stderr: ''
    })
    const operation = operationWith(git)

    await expect(
      operation.mutate('apply', {
        worktreePath: '/repo',
        ref: 'stash@{0}',
        expectedCommitId: OID
      })
    ).rejects.toThrow('stash_revision_changed')
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('registers the complete stash RPC surface', () => {
    const dispatcher = createMockDispatcher()
    registerGitHandlers(
      dispatcher as unknown as Parameters<typeof registerGitHandlers>[0],
      {
        stash: {
          list: vi.fn(),
          files: vi.fn(),
          create: vi.fn(),
          mutate: vi.fn()
        }
      } as unknown as GitHandlerOperationSet,
      vi.fn(),
      vi.fn()
    )
    expect([...dispatcher._requestHandlers.keys()]).toEqual(
      expect.arrayContaining([
        'git.stashList',
        'git.stashFiles',
        'git.stashCreate',
        'git.stashApply',
        'git.stashPop',
        'git.stashDrop'
      ])
    )
  })
})
