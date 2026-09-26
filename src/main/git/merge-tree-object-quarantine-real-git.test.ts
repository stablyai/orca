import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../../shared/git-object-quarantine-real-git.test-fixture'
import {
  __resetPRConflictSummaryCachesForTests,
  getPRConflictSummary
} from '../github/conflict-summary'
import { createLocalGitObjectQuarantine } from './local-git-object-quarantine'
import { gitExecFileAsync } from './runner'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'

// Why: every divergent `merge-tree --write-tree` used to leave unreachable loose objects in the
// real store; enough of them keeps Git's auto-gc re-running forever on large repositories.
describe('merge-tree runs against a scratch object store (real Git)', () => {
  let fixture: DivergentRepoFixture

  beforeEach(() => {
    __resetPRConflictSummaryCachesForTests()
    fixture = createDivergentRepoFixture()
  })

  afterEach(() => {
    fixture.dispose()
  })

  function unquarantinedConflictFiles(cwd: string, base: string, head: string): string[] {
    const mergeBase = fixture.git(cwd, 'merge-base', head, base).trim()
    let stdout: string
    try {
      stdout = fixture.git(
        cwd,
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        mergeBase,
        head,
        base
      )
    } catch (error) {
      // A conflicted merge exits 1 but still prints the file list.
      stdout = error instanceof Error && 'stdout' in error ? String(error.stdout) : ''
    }
    return stdout.split('\0').filter(Boolean).slice(1)
  }

  it.each([
    ['the main worktree', (f: DivergentRepoFixture) => f.repoPath],
    ['a linked worktree', (f: DivergentRepoFixture) => f.linkedPath]
  ])('conflict summary from %s writes no loose objects', async (_label, pickCwd) => {
    const cwd = pickCwd(fixture)
    const base = fixture.git(cwd, 'rev-parse', 'main').trim()
    const head = fixture.git(cwd, 'rev-parse', 'feature-conflict').trim()
    const before = fixture.looseObjectCount()

    const summary = await getPRConflictSummary(cwd, 'main', base, head)

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
    expect(summary?.files).toEqual(['shared.txt'])
    // The unquarantined run proves the fixture really writes objects and the output matches.
    expect(unquarantinedConflictFiles(cwd, base, head)).toEqual(summary?.files)
    expect(fixture.looseObjectCount()).toBeGreaterThan(before)
  })

  it.each([
    ['the main worktree', (f: DivergentRepoFixture) => f.repoPath],
    ['a linked worktree', (f: DivergentRepoFixture) => f.linkedPath]
  ])('branch cleanup from %s writes no loose objects', async (_label, pickCwd) => {
    const cwd = pickCwd(fixture)
    fixture.git(cwd, 'config', 'branch.feature-extra.base', 'refs/heads/main')
    fixture.git(cwd, 'config', 'branch.feature-squashed.base', 'refs/heads/main')
    const extraHead = fixture.git(cwd, 'rev-parse', 'feature-extra').trim()
    const squashedHead = fixture.git(cwd, 'rev-parse', 'feature-squashed').trim()
    const before = fixture.looseObjectCount()

    const extra = await deleteBranchAfterWorktreeRemoval(cwd, 'feature-extra', extraHead, {})
    const squashed = await deleteBranchAfterWorktreeRemoval(
      cwd,
      'feature-squashed',
      squashedHead,
      {}
    )

    expect(fixture.looseObjectCount()).toBe(before)
    expect(fixture.scratchDirectories()).toEqual([])
    expect(extra).toEqual({ preservedBranch: { branchName: 'feature-extra', head: extraHead } })
    expect(squashed).toEqual({})
    // Same verdicts as an unquarantined merge-tree, which does write objects.
    const mainTree = fixture.git(cwd, 'rev-parse', 'main^{tree}').trim()
    const mergeTree = (branch: string): string =>
      fixture.git(cwd, 'merge-tree', '--write-tree', 'main', branch).trim()
    expect(mergeTree('feature-extra')).not.toBe(mainTree)
    expect(mergeTree(squashedHead)).toBe(mainTree)
    expect(fixture.looseObjectCount()).toBeGreaterThan(before)
  })

  it('removes the scratch directory when the Git command fails', async () => {
    const quarantine = createLocalGitObjectQuarantine(fixture.linkedPath)
    let scratch: string | undefined

    await expect(
      quarantine.run(async (env) => {
        scratch = env?.GIT_OBJECT_DIRECTORY
        expect(scratch && existsSync(scratch)).toBe(true)
        return gitExecFileAsync(['merge-tree', '--write-tree', 'main', 'no-such-branch'], {
          cwd: fixture.linkedPath,
          env
        })
      })
    ).rejects.toThrow()

    expect(scratch).toBeDefined()
    expect(existsSync(scratch ?? '')).toBe(false)
    expect(fixture.scratchDirectories()).toEqual([])
  })

  it('removes the scratch directory when the command is aborted', async () => {
    const quarantine = createLocalGitObjectQuarantine(fixture.repoPath)
    const controller = new AbortController()
    let scratch: string | undefined

    await expect(
      quarantine.run(async (env) => {
        scratch = env?.GIT_OBJECT_DIRECTORY
        const running = gitExecFileAsync(['merge-tree', '--write-tree', 'main', 'feature-extra'], {
          cwd: fixture.repoPath,
          env,
          signal: controller.signal
        })
        controller.abort()
        return running
      })
    ).rejects.toThrow()

    expect(scratch).toBeDefined()
    expect(existsSync(scratch ?? '')).toBe(false)
  })
})
