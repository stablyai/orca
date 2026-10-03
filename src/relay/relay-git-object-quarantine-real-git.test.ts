import type * as NodeFsPromises from 'node:fs/promises'
import { basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_OBJECT_QUARANTINE_DIR_PREFIX } from '../shared/git-object-quarantine'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../shared/git-object-quarantine-real-git.test-fixture'
import type { GitHandler } from './git-handler'
import { createGitHandlerRelay } from './git-handler-test-harness'
import type { MockDispatcher } from './git-handler-test-setup'

const scratchFoldersMade = vi.hoisted((): string[] => [])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const made = await actual.mkdtemp(prefix)
      if (basename(made).startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX)) {
        scratchFoldersMade.push(made)
      }
      return made
    }
  }
})

// Why: the SSH relay runs the same merge-tree proof on the remote host's own object store.
describe('relay branch cleanup runs merge-tree against a scratch object store (real Git)', () => {
  let fixture: DivergentRepoFixture
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scratchFoldersMade.length = 0
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

  // Why: the relay quarantines only once a check has shown its Git writes trees; that first check runs as Git always has.
  async function learnMergeTreeSupportThrough(branch: string): Promise<void> {
    await removeWorktreeFor(branch)
  }

  it('still deletes a squash-merged branch through the scratch store', async () => {
    await learnMergeTreeSupportThrough('feature-extra')
    const before = fixture.looseObjectCount()

    await expect(removeWorktreeFor('feature-squashed')).resolves.toEqual({})

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
    expect(fixture.git(fixture.repoPath, 'branch', '--list', 'feature-squashed')).toBe('')
  })

  it('preserves a branch with unmerged changes without writing loose objects', async () => {
    const head = fixture.git(fixture.repoPath, 'rev-parse', 'feature-extra').trim()
    await learnMergeTreeSupportThrough('feature-squashed')
    const before = fixture.looseObjectCount()

    await expect(removeWorktreeFor('feature-extra')).resolves.toEqual({
      preservedBranch: { branchName: 'feature-extra', head }
    })

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
  })

  it('learns from a conflicting check that its Git writes trees, so the next one is quarantined', async () => {
    const head = fixture.git(fixture.repoPath, 'rev-parse', 'feature-conflict').trim()
    const preserved = { preservedBranch: { branchName: 'feature-conflict', head } }
    // No saved base, so HEAD (main) is the only target and each removal runs merge-tree once.
    const removeConflicting = (worktreePath: string) =>
      dispatcher.callRequest('git.removeWorktree', { worktreePath })

    const initial = fixture.looseObjectCount()
    await expect(removeConflicting(fixture.linkedPath)).resolves.toEqual(preserved)
    // The first check ran as Git always has: no scratch folder, so its conflict wrote loose objects.
    expect(scratchFoldersMade).toEqual([])
    const before = fixture.looseObjectCount()
    expect(before).toBeGreaterThan(initial)

    const again = fixture.addWorktree('wt-feature-conflict', 'feature-conflict')
    await expect(removeConflicting(again)).resolves.toEqual(preserved)

    expect(scratchFoldersMade).toHaveLength(1)
    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
  })
})
