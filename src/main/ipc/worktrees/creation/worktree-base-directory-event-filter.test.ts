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
