import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  matchingWorktreeBaseRepoIds,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const COMMON_DIR = join('/repos', 'project', '.git')

function makeGitCommonTarget(): WorktreeBaseWatchTarget {
  return {
    key: `git-common:local:${COMMON_DIR}`,
    kind: 'git-common',
    path: COMMON_DIR,
    repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
  }
}

describe('matchingWorktreeBaseRepoIds (git-common)', () => {
  it('matches linked-worktree metadata under worktrees/', () => {
    const target = makeGitCommonTarget()
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'HEAD')
      })
    ).toEqual(['repo-1'])
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'create',
        path: join(COMMON_DIR, 'worktrees', 'wt-b')
      })
    ).toEqual(['repo-1'])
  })

  it('matches primary-checkout branch/index metadata at the common-dir top level', () => {
    const target = makeGitCommonTarget()
    for (const file of ['HEAD', 'packed-refs', 'index']) {
      expect(
        matchingWorktreeBaseRepoIds(target, { type: 'update', path: join(COMMON_DIR, file) })
      ).toEqual(['repo-1'])
    }
  })

  it('ignores non-status common-dir churn', () => {
    const target = makeGitCommonTarget()
    for (const path of [
      join(COMMON_DIR, 'config'),
      join(COMMON_DIR, 'FETCH_HEAD'),
      join(COMMON_DIR, 'COMMIT_EDITMSG'),
      join(COMMON_DIR, 'objects', 'ab', 'cdef'),
      join(COMMON_DIR, 'refs', 'heads', 'main'),
      join(COMMON_DIR, 'logs', 'HEAD'),
      // Nested HEAD outside worktrees/ must not be mistaken for the primary's.
      join(COMMON_DIR, 'modules', 'sub', 'HEAD')
    ]) {
      expect(matchingWorktreeBaseRepoIds(target, { type: 'update', path })).toEqual([])
    }
  })

  it('ignores paths outside the watch root', () => {
    const target = makeGitCommonTarget()
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'update',
        path: join('/repos', 'project', 'HEAD')
      })
    ).toEqual([])
  })
})
