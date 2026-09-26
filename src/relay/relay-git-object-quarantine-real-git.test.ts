import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../shared/git-object-quarantine-real-git.test-fixture'
import type { GitHandler } from './git-handler'
import { createGitHandlerRelay } from './git-handler-test-harness'
import type { MockDispatcher } from './git-handler-test-setup'

// Why: the SSH relay runs the same merge-tree proof on the remote host's own object store.
describe('relay branch cleanup runs merge-tree against a scratch object store (real Git)', () => {
  let fixture: DivergentRepoFixture
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fixture = createDivergentRepoFixture()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(() => {
    handler.dispose()
    fixture.dispose()
    vi.restoreAllMocks()
  })

  function removeWorktreeFor(branch: string): Promise<unknown> {
    fixture.git(fixture.repoPath, 'config', `branch.${branch}.base`, 'refs/heads/main')
    const worktreePath = fixture.addWorktree(`wt-${branch}`, branch)
    return dispatcher.callRequest('git.removeWorktree', { worktreePath })
  }

  it('deletes a squash-merged branch without writing loose objects', async () => {
    const before = fixture.looseObjectCount()

    await expect(removeWorktreeFor('feature-squashed')).resolves.toEqual({})

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
    expect(fixture.git(fixture.repoPath, 'branch', '--list', 'feature-squashed')).toBe('')
  })

  it('preserves a branch with unmerged changes without writing loose objects', async () => {
    const head = fixture.git(fixture.repoPath, 'rev-parse', 'feature-extra').trim()
    const before = fixture.looseObjectCount()

    await expect(removeWorktreeFor('feature-extra')).resolves.toEqual({
      preservedBranch: { branchName: 'feature-extra', head }
    })

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
  })
})
