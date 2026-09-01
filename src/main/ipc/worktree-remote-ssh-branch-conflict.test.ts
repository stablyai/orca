import { describe, expect, it, vi } from 'vitest'

import { getSshBranchConflictKind } from './worktree-remote'

type ConflictProvider = Parameters<typeof getSshBranchConflictKind>[0]

function providerAnswering(answers: {
  remotes: string[]
  localBranchHead?: string
  remoteRefs: string[]
}): ConflictProvider {
  const exec: ConflictProvider['exec'] = vi.fn(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: `${answers.remotes.join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse') {
      if (!answers.localBranchHead) {
        throw new Error('missing ref')
      }
      return { stdout: `${answers.localBranchHead}\n`, stderr: '' }
    }
    if (args[0] === 'show-ref') {
      const matches = answers.remoteRefs.filter((ref) => args.includes(ref))
      if (matches.length > 0) {
        return {
          stdout: `${matches.map((ref) => `abc ${ref}`).join('\n')}\n`,
          stderr: ''
        }
      }
      throw Object.assign(new Error('missing remote ref'), { code: 1 })
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
  return { exec }
}

describe('getSshBranchConflictKind remote ownership', () => {
  it('reports a local branch before scanning remote refs', async () => {
    const provider = providerAnswering({
      localBranchHead: 'abc123',
      remotes: ['origin'],
      remoteRefs: []
    })

    await expect(
      getSshBranchConflictKind(provider, '/srv/repo', 'my-task', 'origin/main')
    ).resolves.toBe('local')
  })

  it('ignores a ref whose prefix matches no configured remote', async () => {
    const provider = providerAnswering({
      remotes: ['origin'],
      remoteRefs: ['refs/remotes/origin/main', 'refs/remotes/deleted-fork/my-task']
    })

    await expect(
      getSshBranchConflictKind(provider, '/srv/repo', 'my-task', 'origin/main')
    ).resolves.toBeNull()
  })

  it('still reports a ref owned by a configured remote', async () => {
    const provider = providerAnswering({
      remotes: ['origin'],
      remoteRefs: ['refs/remotes/origin/main', 'refs/remotes/origin/my-task']
    })

    await expect(
      getSshBranchConflictKind(provider, '/srv/repo', 'my-task', 'origin/main')
    ).resolves.toBe('remote')
  })

  it('prefers the longest configured remote name', async () => {
    const provider = providerAnswering({
      remotes: ['foo', 'foo/bar'],
      remoteRefs: ['refs/remotes/foo/bar/my-task']
    })

    await expect(
      getSshBranchConflictKind(provider, '/srv/repo', 'my-task', 'origin/main')
    ).resolves.toBe('remote')
  })
})
