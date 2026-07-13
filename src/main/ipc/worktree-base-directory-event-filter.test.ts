import { describe, expect, it } from 'vitest'
import { join, win32 } from 'node:path'
import {
  classifyWorktreeBaseChange,
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
  it('classifies linked-worktree structural metadata under worktrees/', () => {
    const target = makeGitCommonTarget()
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'HEAD')
      })
    ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'create',
        path: join(COMMON_DIR, 'worktrees', 'wt-b')
      })
    ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'delete',
        path: join(COMMON_DIR, 'worktrees', 'wt-b')
      })
    ).toEqual(['repo-1'])
  })

  it('classifies primary-checkout branch metadata as structural and index as status-only', () => {
    const target = makeGitCommonTarget()
    for (const file of ['HEAD', 'packed-refs']) {
      expect(
        classifyWorktreeBaseChange(target, { type: 'update', path: join(COMMON_DIR, file) })
      ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
    }
    expect(
      classifyWorktreeBaseChange(target, { type: 'update', path: join(COMMON_DIR, 'index') })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: ['repo-1'] })
  })

  it('classifies linked-worktree index as status-only', () => {
    const target = makeGitCommonTarget()
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'index')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: ['repo-1'] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'index.lock')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: [] })
  })

  it('classifies HEAD reflog appends as status-only for linked and primary checkouts', () => {
    const target = makeGitCommonTarget()
    // commit --amend / reset --soft move HEAD without touching index or HEAD.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'HEAD')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: ['repo-1'] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'logs', 'HEAD')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: ['repo-1'] })
    // Per-ref reflogs churn on fetches and stay ignored.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'logs', 'refs', 'heads', 'main')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: [] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'refs', 'heads', 'main')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: [] })
  })

  it('classifies worktree-scoped config as structural for sparse-flag freshness', () => {
    const target = makeGitCommonTarget()
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'config.worktree')
      })
    ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'create',
        path: join(COMMON_DIR, 'config.worktree')
      })
    ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
  })

  it('classifies Windows-shaped linked metadata paths', () => {
    const commonDir = win32.join('C:\\', 'repos', 'project', '.git')
    const target: WorktreeBaseWatchTarget = {
      ...makeGitCommonTarget(),
      key: `git-common:local:${commonDir}`,
      path: commonDir
    }
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: win32.join(commonDir, 'worktrees', 'wt a', 'gitdir')
      })
    ).toEqual({ structureRepoIds: ['repo-1'], gitStatusRepoIds: [] })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: win32.join(commonDir, 'worktrees', 'wt a', 'index')
      })
    ).toEqual({ structureRepoIds: [], gitStatusRepoIds: ['repo-1'] })
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
