import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearActiveGitStatusRefBinding,
  updateActiveGitStatusRefBinding,
  type GitStatusRefBindingRequest,
  type GitStatusRefWatchTarget
} from './worktree-git-status-ref-watch'

function makeTarget(): GitStatusRefWatchTarget {
  return {
    kind: 'git-common',
    path: 'C:\\repo\\.git',
    repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'repo', nestWorkspaces: false }]]),
    gitStatusRefPaths: new Set()
  }
}

describe('worktree git status ref watch binding', () => {
  afterEach(() => clearActiveGitStatusRefBinding())

  function request(overrides: Partial<GitStatusRefBindingRequest> = {}) {
    return {
      worktreeId: 'repo-1::C:\\repo',
      worktreePath: 'C:\\repo',
      executionHostId: 'local',
      branch: 'refs/heads/feature/main',
      upstreamName: 'origin/feature/main',
      ...overrides
    }
  }

  it('binds a custom refspec destination exactly', async () => {
    const target = makeTarget()
    await updateActiveGitStatusRefBinding(
      request(),
      () => [target],
      async () => 'refs/custom/origin/main'
    )

    expect([...target.gitStatusRefPaths]).toEqual(['C:/repo/.git/refs/custom/origin/main'])
  })

  it('does not spend the dynamic ref stat on a slash-named local upstream', async () => {
    const target = makeTarget()
    await updateActiveGitStatusRefBinding(
      request(),
      () => [target],
      async () => 'refs/heads/feature/base'
    )

    expect(target.gitStatusRefPaths).toEqual(new Set())
  })

  it('keeps a slash-containing remote name exact', async () => {
    const target = makeTarget()
    await updateActiveGitStatusRefBinding(
      request(),
      () => [target],
      async () => 'refs/remotes/team/fork/feature/main'
    )

    expect([...target.gitStatusRefPaths]).toEqual([
      'C:/repo/.git/refs/remotes/team/fork/feature/main'
    ])
  })

  it('does not resolve the exact ref again on unchanged status ticks', async () => {
    const target = makeTarget()
    const resolve = vi.fn(async () => 'refs/remotes/origin/feature/main')

    await updateActiveGitStatusRefBinding(request(), () => [target], resolve)
    await updateActiveGitStatusRefBinding(request(), () => [target], resolve)

    expect(resolve).toHaveBeenCalledOnce()
  })

  it('applies an in-flight resolution to a replacement watch', async () => {
    const first = makeTarget()
    const replacement = makeTarget()
    let current = [first]
    let finish: (ref: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })

    const update = updateActiveGitStatusRefBinding(
      request(),
      () => current,
      () => pending
    )
    current = [replacement]
    finish('refs/remotes/origin/feature/main')
    await update

    expect(first.gitStatusRefPaths).toEqual(new Set())
    expect([...replacement.gitStatusRefPaths]).toEqual([
      'C:/repo/.git/refs/remotes/origin/feature/main'
    ])

    const latest = makeTarget()
    current = [latest]
    const resolve = vi.fn(async () => 'refs/remotes/origin/feature/main')
    await updateActiveGitStatusRefBinding(request(), () => current, resolve)
    expect(resolve).not.toHaveBeenCalled()
    expect([...latest.gitStatusRefPaths]).toEqual(['C:/repo/.git/refs/remotes/origin/feature/main'])
  })
})
