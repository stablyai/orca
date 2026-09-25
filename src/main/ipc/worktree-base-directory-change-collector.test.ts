import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges
} from './worktree-base-directory-change-collector'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import { EMPTY_HEAD_IDENTITY_SCOPE, FULL_HEAD_IDENTITY_SCOPE } from './worktree-head-identity-scope'

const COMMON_DIR = join('/repos', 'project', '.git')

function makeTarget(): WorktreeBaseWatchTarget {
  return {
    key: `git-common:local:${COMMON_DIR}`,
    kind: 'git-common',
    path: COMMON_DIR,
    repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
  }
}

describe('worktree base change collector', () => {
  it('states the full head scope on overflow rather than leaving it absent', () => {
    // Overflow means every event in the window was lost. Stating FULL here — not
    // relying on a downstream `?? FULL` for a missing field — is what keeps a
    // future caller that forwards this object from reading it as "nothing moved".
    const changes = collectRemoteWorktreeBaseChanges(makeTarget(), [{ kind: 'overflow' }] as never)

    expect(changes.overflow).toBe(true)
    expect(changes.headIdentityScope).toEqual(FULL_HEAD_IDENTITY_SCOPE)
  })

  it('unions the head scopes of every event in a burst', () => {
    const changes = collectLocalWorktreeBaseChanges(makeTarget(), [
      { type: 'update', path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'HEAD') },
      { type: 'update', path: join(COMMON_DIR, 'worktrees', 'wt-b', 'HEAD') },
      { type: 'update', path: join(COMMON_DIR, 'logs', 'HEAD') },
      // Status-tier churn contributes nothing to the head scope.
      { type: 'update', path: join(COMMON_DIR, 'worktrees', 'wt-c', 'index') }
    ])

    expect(changes.headIdentityScope).toEqual({
      listing: false,
      primary: true,
      all: false,
      entryNames: new Set(['wt-a', 'wt-b'])
    })
  })

  it('lets one packed-refs write widen the whole burst to a full re-read', () => {
    const changes = collectLocalWorktreeBaseChanges(makeTarget(), [
      { type: 'update', path: join(COMMON_DIR, 'worktrees', 'wt-a', 'logs', 'HEAD') },
      { type: 'update', path: join(COMMON_DIR, 'packed-refs') }
    ])

    expect(changes.headIdentityScope).toEqual(FULL_HEAD_IDENTITY_SCOPE)
  })

  it('keeps the head scope empty for a burst that can move no head', () => {
    const changes = collectLocalWorktreeBaseChanges(makeTarget(), [
      { type: 'create', path: join(COMMON_DIR, 'worktrees', 'wt-a', 'locked') },
      { type: 'update', path: join(COMMON_DIR, 'worktrees', 'wt-a', 'index') },
      { type: 'update', path: join(COMMON_DIR, 'config') }
    ])

    expect(changes.headIdentityScope).toEqual(EMPTY_HEAD_IDENTITY_SCOPE)
    expect(changes.structureRepoIds).toEqual(['repo-1'])
  })

  it('narrows a rename to the entries on both sides', () => {
    const changes = collectRemoteWorktreeBaseChanges(makeTarget(), [
      {
        kind: 'rename',
        absolutePath: join(COMMON_DIR, 'worktrees', 'wt-new', 'HEAD'),
        oldAbsolutePath: join(COMMON_DIR, 'worktrees', 'wt-old', 'HEAD')
      }
    ] as never)

    expect(changes.headIdentityScope).toEqual({
      listing: false,
      primary: false,
      all: false,
      entryNames: new Set(['wt-old', 'wt-new'])
    })
  })
})
