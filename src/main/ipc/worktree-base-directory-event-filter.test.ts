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
    ).toEqual({
      structureRepoIds: ['repo-1'],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'create',
        path: join(COMMON_DIR, 'worktrees', 'wt-b')
      })
    ).toEqual({
      structureRepoIds: ['repo-1'],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
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
        classifyWorktreeBaseChange(target, {
          type: 'update',
          path: join(COMMON_DIR, file)
        })
      ).toEqual({
        structureRepoIds: ['repo-1'],
        gitStatusRepoIds: [],
        headIdentityRepoIds: []
      })
    }
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'index')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: ['repo-1'],
      headIdentityRepoIds: []
    })
  })

  it('classifies linked-worktree index as status-only', () => {
    const target = makeGitCommonTarget()
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'index')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: ['repo-1'],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'index.lock')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
  })

  it('classifies HEAD reflog appends as head-identity triggers for linked and primary checkouts', () => {
    const target = makeGitCommonTarget()
    // commit --amend / reset --soft move HEAD without touching index or HEAD.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'HEAD')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: ['repo-1']
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'logs', 'HEAD')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: ['repo-1']
    })
    // Per-ref reflogs churn on fetches and stay ignored.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'logs', 'refs', 'heads', 'main')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'refs', 'heads', 'main')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
  })

  it('classifies worktree-scoped config as structural for sparse-flag freshness', () => {
    const target = makeGitCommonTarget()
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'worktrees', 'wt-a', 'config.worktree')
      })
    ).toEqual({
      structureRepoIds: ['repo-1'],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'create',
        path: join(COMMON_DIR, 'config.worktree')
      })
    ).toEqual({
      structureRepoIds: ['repo-1'],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
  })

  it('classifies config and the exact upstream ref as status-only external push signals', () => {
    const target = makeGitCommonTarget()
    // External `git push -u` writes only branch.<name>.remote/merge into the
    // common config; without this signal the upstream stays invisible until a
    // safety poll.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'config')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: ['repo-1'],
      headIdentityRepoIds: []
    })
    const boundPaths = [
      join(COMMON_DIR, 'refs', 'remotes', 'origin', 'main'),
      // Branch names with slashes nest arbitrarily deep.
      join(COMMON_DIR, 'refs', 'remotes', 'team', 'fork', 'feature', 'nested'),
      join(COMMON_DIR, 'refs', 'custom', 'origin', 'main')
    ]
    for (const path of boundPaths) {
      target.gitStatusRefPaths = new Set([path])
      for (const type of ['create', 'update'] as const) {
        expect(classifyWorktreeBaseChange(target, { type, path })).toEqual({
          structureRepoIds: [],
          gitStatusRepoIds: ['repo-1'],
          headIdentityRepoIds: []
        })
      }
    }
    // Ref-lock churn from an in-flight or aborted ref update stays invisible.
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'create',
        path: join(COMMON_DIR, 'refs', 'remotes', 'origin', 'main.lock')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: join(COMMON_DIR, 'refs', 'remotes', 'origin', 'unrelated')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
  })

  it('classifies Windows-shaped linked metadata paths', () => {
    const commonDir = win32.join('C:\\', 'repos', 'project', '.git')
    const target: WorktreeBaseWatchTarget = {
      ...makeGitCommonTarget(),
      key: `git-common:local:${commonDir}`,
      path: commonDir,
      gitStatusRefPaths: new Set([win32.join(commonDir, 'refs', 'remotes', 'origin', 'main')])
    }
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: win32.join(commonDir, 'worktrees', 'wt a', 'gitdir')
      })
    ).toEqual({
      structureRepoIds: ['repo-1'],
      gitStatusRepoIds: [],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: win32.join(commonDir, 'worktrees', 'wt a', 'index')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: ['repo-1'],
      headIdentityRepoIds: []
    })
    expect(
      classifyWorktreeBaseChange(target, {
        type: 'update',
        path: win32.join(commonDir, 'refs', 'remotes', 'origin', 'main')
      })
    ).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: ['repo-1'],
      headIdentityRepoIds: []
    })
  })

  it('ignores non-status common-dir churn', () => {
    const target = makeGitCommonTarget()
    for (const path of [
      join(COMMON_DIR, 'FETCH_HEAD'),
      join(COMMON_DIR, 'COMMIT_EDITMSG'),
      join(COMMON_DIR, 'objects', 'ab', 'cdef'),
      // Local branch tips churn on every commit; head moves surface via logs/HEAD.
      join(COMMON_DIR, 'refs', 'heads', 'main'),
      // Remote-tracking reflogs churn alongside every push/fetch ref update.
      join(COMMON_DIR, 'logs', 'refs', 'remotes', 'origin', 'main'),
      // Nested HEAD outside worktrees/ must not be mistaken for the primary's.
      join(COMMON_DIR, 'modules', 'sub', 'HEAD')
    ]) {
      expect(classifyWorktreeBaseChange(target, { type: 'update', path })).toEqual({
        structureRepoIds: [],
        gitStatusRepoIds: [],
        headIdentityRepoIds: []
      })
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
