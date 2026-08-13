import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteReviewHeadLocalRefs,
  listOrcaReviewHeadLocalRefs,
  otherWorktreesStillLinkReview,
  pruneReviewHeadLocalRefsAfterWorktreeDelete
} from './review-head-ref-prune'
import type { WorktreeMeta } from '../../shared/types'

function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

/** Snapshot-style helper for single-threaded tests. */
function finalizeFromMap(
  map: Record<string, WorktreeMeta | undefined>,
  deletedWorktreeId: string
): () => Record<string, WorktreeMeta | undefined> {
  return () => {
    delete map[deletedWorktreeId]
    return { ...map }
  }
}

describe('otherWorktreesStillLinkReview', () => {
  it('is false when no other worktree shares the PR', () => {
    expect(
      otherWorktreesStillLinkReview(
        {
          'repo-a::/wt/pr-42': meta({ linkedPR: 42 }),
          'repo-a::/wt/other': meta({ linkedPR: 7 })
        },
        {
          excludeWorktreeId: 'repo-a::/wt/pr-42',
          repoId: 'repo-a',
          githubPrNumber: 42
        }
      )
    ).toBe(false)
  })

  it('is true when a sibling worktree still links the same PR', () => {
    expect(
      otherWorktreesStillLinkReview(
        {
          'repo-a::/wt/pr-42-a': meta({ linkedPR: 42 }),
          'repo-a::/wt/pr-42-b': meta({ linkedPR: 42 })
        },
        {
          excludeWorktreeId: 'repo-a::/wt/pr-42-a',
          repoId: 'repo-a',
          githubPrNumber: 42
        }
      )
    ).toBe(true)
  })

  it('ignores worktrees in a different repo', () => {
    expect(
      otherWorktreesStillLinkReview(
        {
          'repo-a::/wt/pr-42': meta({ linkedPR: 42 }),
          'repo-b::/wt/pr-42': meta({ linkedPR: 42 })
        },
        {
          excludeWorktreeId: 'repo-a::/wt/pr-42',
          repoId: 'repo-a',
          githubPrNumber: 42
        }
      )
    ).toBe(false)
  })
})

describe('pruneReviewHeadLocalRefsAfterWorktreeDelete', () => {
  const gitExec = vi.fn()

  beforeEach(() => {
    gitExec.mockReset()
  })

  it('deletes matching durable PR refs when this was the last linked worktree', async () => {
    gitExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return {
          stdout: [
            'refs/orca/pull/origin-aaa/42',
            'refs/orca/pull/origin-aaa/99',
            'refs/orca/merge-requests/origin-aaa/42',
            ''
          ].join('\n'),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    const map: Record<string, WorktreeMeta | undefined> = {
      'repo-a::/wt/pr-42': meta({ linkedPR: 42 }),
      'repo-a::/wt/other': meta({ linkedPR: 7 })
    }

    const deleted = await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: '/repo',
      repoId: 'repo-a',
      deletedWorktreeId: 'repo-a::/wt/pr-42',
      meta: meta({ linkedPR: 42 }),
      finalizeDeletedMetaAndReadSiblings: finalizeFromMap(map, 'repo-a::/wt/pr-42'),
      gitExec
    })

    expect(deleted).toEqual(['refs/orca/pull/origin-aaa/42'])
    expect(gitExec).toHaveBeenCalledWith(['update-ref', '-d', 'refs/orca/pull/origin-aaa/42'])
    expect(gitExec).not.toHaveBeenCalledWith(['update-ref', '-d', 'refs/orca/pull/origin-aaa/99'])
  })

  it('does not delete when another worktree still links the PR', async () => {
    const map: Record<string, WorktreeMeta | undefined> = {
      'repo-a::/wt/pr-42-a': meta({ linkedPR: 42 }),
      'repo-a::/wt/pr-42-b': meta({ linkedPR: 42 })
    }

    const deleted = await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: '/repo',
      repoId: 'repo-a',
      deletedWorktreeId: 'repo-a::/wt/pr-42-a',
      meta: meta({ linkedPR: 42 }),
      finalizeDeletedMetaAndReadSiblings: finalizeFromMap(map, 'repo-a::/wt/pr-42-a'),
      gitExec
    })

    expect(deleted).toEqual([])
    expect(gitExec).not.toHaveBeenCalled()
    // First of two still-linked deletes only drops its own meta entry.
    expect(map['repo-a::/wt/pr-42-a']).toBeUndefined()
    expect(map['repo-a::/wt/pr-42-b']).toBeDefined()
  })

  it('prunes GitLab MR refs when linkedGitLabMR is set', async () => {
    gitExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return {
          stdout: 'refs/orca/merge-requests/origin-bbb/15\nrefs/orca/pull/origin-bbb/15\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    const map: Record<string, WorktreeMeta | undefined> = {
      'repo-a::/wt/mr-15': meta({ linkedGitLabMR: 15 })
    }

    const deleted = await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: '/repo',
      repoId: 'repo-a',
      deletedWorktreeId: 'repo-a::/wt/mr-15',
      meta: meta({ linkedGitLabMR: 15 }),
      finalizeDeletedMetaAndReadSiblings: finalizeFromMap(map, 'repo-a::/wt/mr-15'),
      gitExec
    })

    expect(deleted).toEqual(['refs/orca/merge-requests/origin-bbb/15'])
  })

  it('no-ops without linked PR/MR metadata', async () => {
    const deleted = await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: '/repo',
      repoId: 'repo-a',
      deletedWorktreeId: 'repo-a::/wt/plain',
      meta: meta(),
      finalizeDeletedMetaAndReadSiblings: () => ({}),
      gitExec
    })
    expect(deleted).toEqual([])
    expect(gitExec).not.toHaveBeenCalled()
  })

  it('prunes when two last linked worktrees delete concurrently (shared live meta)', async () => {
    // Why: snapshot-before-lock would leave each call seeing the other sibling and both skip.
    gitExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return {
          stdout: 'refs/orca/pull/origin-aaa/42\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    const liveMeta: Record<string, WorktreeMeta | undefined> = {
      'repo-a::/wt/pr-42-a': meta({ linkedPR: 42 }),
      'repo-a::/wt/pr-42-b': meta({ linkedPR: 42 })
    }

    const makeFinalize = (id: string) => () => {
      delete liveMeta[id]
      return { ...liveMeta }
    }

    const [deletedA, deletedB] = await Promise.all([
      pruneReviewHeadLocalRefsAfterWorktreeDelete({
        repoPath: '/repo',
        repoId: 'repo-a',
        deletedWorktreeId: 'repo-a::/wt/pr-42-a',
        meta: meta({ linkedPR: 42 }),
        finalizeDeletedMetaAndReadSiblings: makeFinalize('repo-a::/wt/pr-42-a'),
        gitExec
      }),
      pruneReviewHeadLocalRefsAfterWorktreeDelete({
        repoPath: '/repo',
        repoId: 'repo-a',
        deletedWorktreeId: 'repo-a::/wt/pr-42-b',
        meta: meta({ linkedPR: 42 }),
        finalizeDeletedMetaAndReadSiblings: makeFinalize('repo-a::/wt/pr-42-b'),
        gitExec
      })
    ])

    const allDeleted = [...deletedA, ...deletedB]
    expect(allDeleted).toContain('refs/orca/pull/origin-aaa/42')
    // Exactly one of the two finalizers should have performed the prune.
    expect(allDeleted.filter((r) => r === 'refs/orca/pull/origin-aaa/42')).toHaveLength(1)
    expect(liveMeta).toEqual({})
  })
})

describe('listOrcaReviewHeadLocalRefs / deleteReviewHeadLocalRefs', () => {
  it('lists and deletes refs', async () => {
    const gitExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'refs/orca/pull/c/1\nrefs/orca/pull/c/2\n',
        stderr: ''
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(listOrcaReviewHeadLocalRefs(gitExec)).resolves.toEqual([
      'refs/orca/pull/c/1',
      'refs/orca/pull/c/2'
    ])
    await expect(deleteReviewHeadLocalRefs(gitExec, ['refs/orca/pull/c/1'])).resolves.toEqual([
      'refs/orca/pull/c/1'
    ])
  })
})
