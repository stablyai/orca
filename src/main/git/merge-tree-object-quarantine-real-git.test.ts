import { readdirSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_OBJECT_QUARANTINE_DIR_PREFIX } from '../../shared/git/objects/git-object-quarantine'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../../shared/git/objects/git-object-quarantine-real-git.test-fixture'
import {
  __resetPRConflictSummaryCachesForTests,
  getPRConflictSummary
} from '../github/conflict-summary'
import { __resetPRConflictSummaryDerivationCachesForTests } from '../github/conflict-summary-cache'
import { getLocalGitCapabilityCache } from './command-runner/host-routing/git-capability-state'

import { deleteBranchAfterWorktreeRemoval } from './worktrees/removal/worktree-branch-removal'

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

function rememberMergeTreeWritesTrees(): void {
  getLocalGitCapabilityCache().rememberSupported('merge-tree-write-tree')
}

// Quarantine throwaway merge objects so unreachable loose objects cannot repeatedly trigger auto-GC.
describe('merge-tree runs against a scratch object store (real Git)', () => {
  let fixture: DivergentRepoFixture

  beforeEach(() => {
    __resetPRConflictSummaryCachesForTests()
    rememberMergeTreeWritesTrees()
    scratchFoldersMade.length = 0
    fixture = createDivergentRepoFixture()
  })

  afterEach(() => {
    fixture.dispose()
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
    const mainTree = fixture.git(cwd, 'rev-parse', 'main^{tree}').trim()
    const mergeTree = (branch: string): string =>
      fixture.git(cwd, 'merge-tree', '--write-tree', 'main', branch).trim()
    expect(mergeTree('feature-extra')).not.toBe(mainTree)
    expect(mergeTree(squashedHead)).toBe(mainTree)
    expect(fixture.looseObjectCount()).toBeGreaterThan(before)
  })
})

describe('merge-tree quarantine keeps the object stores Git would otherwise see (real Git)', () => {
  let fixture: DivergentRepoFixture

  beforeEach(() => {
    __resetPRConflictSummaryCachesForTests()
    rememberMergeTreeWritesTrees()
    scratchFoldersMade.length = 0
    fixture = createDivergentRepoFixture()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fixture.dispose()
  })

  const BRANCHES = ['main', 'feature-conflict', 'feature-extra', 'feature-squashed']
  const fixtureHead = (branch: string): string =>
    fixture.git(fixture.repoPath, 'rev-parse', branch).trim()

  function emptyRepo(name: string): string {
    const repo = join(dirname(fixture.repoPath), name)
    fixture.git(dirname(fixture.repoPath), 'init', '--quiet', repo)
    return repo
  }

  /** Points `repo`'s branches at the fixture's commits; their objects must already be reachable. */
  function addFixtureBranches(repo: string): void {
    for (const branch of BRANCHES) {
      fixture.git(repo, 'update-ref', `refs/heads/${branch}`, fixtureHead(branch))
    }
    fixture.git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    fixture.git(repo, 'config', 'branch.feature-extra.base', 'refs/heads/main')
    fixture.git(repo, 'config', 'branch.feature-squashed.base', 'refs/heads/main')
  }

  const looseObjectsIn = (repo: string): number => {
    const objects = join(repo, '.git', 'objects')
    return readdirSync(objects)
      .filter((entry) => /^[0-9a-f]{2}$/.test(entry))
      .reduce((count, entry) => count + readdirSync(join(objects, entry)).length, 0)
  }

  async function expectUnquarantinedVerdicts(repo: string): Promise<void> {
    const summary = await getPRConflictSummary(
      repo,
      'main',
      fixtureHead('main'),
      fixtureHead('feature-conflict')
    )
    const extra = await deleteBranchAfterWorktreeRemoval(
      repo,
      'feature-extra',
      fixtureHead('feature-extra'),
      {}
    )
    const squashed = await deleteBranchAfterWorktreeRemoval(
      repo,
      'feature-squashed',
      fixtureHead('feature-squashed'),
      {}
    )

    expect(summary?.files).toEqual(['shared.txt'])
    expect(extra).toEqual({
      preservedBranch: { branchName: 'feature-extra', head: fixtureHead('feature-extra') }
    })
    expect(squashed).toEqual({})
    expect(fixture.git(repo, 'branch', '--list', 'feature-squashed')).toBe('')
  }

  it('reads objects reachable only through inherited GIT_ALTERNATE_OBJECT_DIRECTORIES', async () => {
    const repo = emptyRepo('reached-by-env-alternates')
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', join(fixture.commonDir, 'objects'))
    addFixtureBranches(repo)

    await expectUnquarantinedVerdicts(repo)

    expect(looseObjectsIn(repo)).toBe(0)
  })

  it('leaves an inherited GIT_OBJECT_DIRECTORY in charge, writing where Git would', async () => {
    const repo = emptyRepo('inherited-object-dir')
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(fixture.commonDir, 'objects'))
    addFixtureBranches(repo)
    const before = fixture.looseObjectCount()

    await expectUnquarantinedVerdicts(repo)

    expect(fixture.looseObjectCount()).toBeGreaterThan(before)
    expect(fixture.scratchDirectories()).toEqual([])
  })

  it('reads through an info/alternates chain at the deepest nesting Git accepts', async () => {
    let linked = join(fixture.commonDir, 'objects')
    let repo = ''
    for (let depth = 1; depth <= 6; depth++) {
      repo = emptyRepo(`alternates-chain-${depth}`)
      writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${linked}\n`)
      linked = join(repo, '.git', 'objects')
    }
    addFixtureBranches(repo)

    await expectUnquarantinedVerdicts(repo)

    expect(looseObjectsIn(repo)).toBeGreaterThan(0)
  })
})
