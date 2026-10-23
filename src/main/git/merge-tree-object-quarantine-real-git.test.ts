import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_OBJECT_QUARANTINE_DIR_PREFIX } from '../../shared/git-object-quarantine'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../../shared/git-object-quarantine-real-git.test-fixture'
import {
  __resetPRConflictSummaryCachesForTests,
  getPRConflictSummary
} from '../github/conflict-summary'
import { __resetPRConflictSummaryDerivationCachesForTests } from '../github/conflict-summary-cache'
import { getLocalGitCapabilityCache } from './git-capability-state'
import { createLocalGitObjectQuarantine } from './local-git-object-quarantine'
import { gitExecFileAsync } from './runner'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'

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

/** Records what a first successful check teaches the host; the cold path has its own test. */
function rememberMergeTreeWritesTrees(): void {
  getLocalGitCapabilityCache().rememberSupported('merge-tree-write-tree')
}

// Why: every divergent `merge-tree --write-tree` used to leave unreachable loose objects in the
// real store; enough of them keeps Git's auto-gc re-running forever on large repositories.
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

  it('keeps file contents a partial clone downloads, so the next check does not fetch them again', async () => {
    const clone = fixture.createPartialClone()
    const git = (...args: string[]): string => fixture.git(clone.clonePath, ...args).trim()
    const base = git('rev-parse', 'origin/main')
    const head = git('rev-parse', 'origin/feature-conflict')
    const packsBefore = clone.packCount()
    const looseBefore = clone.looseObjectCount()

    const first = await getPRConflictSummary(clone.clonePath, 'main', base, head)
    const packsAfterFirst = clone.packCount()
    __resetPRConflictSummaryDerivationCachesForTests()
    const second = await getPRConflictSummary(clone.clonePath, 'main', base, head)

    expect(first?.files).toEqual(['shared.txt'])
    expect(second?.files).toEqual(['shared.txt'])
    // The first check fetched the missing blobs into the real store; the second found them there.
    expect(packsAfterFirst).toBeGreaterThan(packsBefore)
    expect(clone.packCount()).toBe(packsAfterFirst)
    expect(clone.looseObjectCount()).toBe(looseBefore)
    expect(scratchFoldersMade).toHaveLength(2)
    expect(clone.scratchDirectories()).toEqual([])
  })

  it('lists a partial clone’s conflicts offline once an earlier check downloaded the contents', async () => {
    const clone = fixture.createPartialClone()
    const git = (...args: string[]): string => fixture.git(clone.clonePath, ...args).trim()
    const base = git('rev-parse', 'origin/main')
    const head = git('rev-parse', 'origin/feature-conflict')

    const online = await getPRConflictSummary(clone.clonePath, 'main', base, head)
    git('remote', 'set-url', 'origin', join(dirname(clone.clonePath), 'unreachable-origin'))
    __resetPRConflictSummaryDerivationCachesForTests()
    const offline = await getPRConflictSummary(clone.clonePath, 'main', base, head)

    expect(online?.files).toEqual(['shared.txt'])
    expect(offline?.files).toEqual(['shared.txt'])
    expect(scratchFoldersMade).toHaveLength(2)
    expect(clone.scratchDirectories()).toEqual([])
  })

  it('makes no scratch folder until a check shows this Git writes trees, then one per check', async () => {
    __resetPRConflictSummaryCachesForTests()
    const base = fixture.git(fixture.repoPath, 'rev-parse', 'main').trim()
    const head = fixture.git(fixture.repoPath, 'rev-parse', 'feature-conflict').trim()

    const first = await getPRConflictSummary(fixture.repoPath, 'main', base, head)
    expect(scratchFoldersMade).toEqual([])
    __resetPRConflictSummaryDerivationCachesForTests()
    const second = await getPRConflictSummary(fixture.repoPath, 'main', base, head)

    expect(first?.files).toEqual(['shared.txt'])
    expect(second?.files).toEqual(['shared.txt'])
    expect(scratchFoldersMade).toHaveLength(1)
    expect(fixture.scratchDirectories()).toEqual([])
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

// Why: the quarantine must leave Git seeing exactly the object stores it sees without it.
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

    // Unquarantined, Git writes the merge results into the store it was handed.
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

    // A store with its own alternates runs unquarantined, so Git writes where it always has.
    expect(looseObjectsIn(repo)).toBeGreaterThan(0)
  })
})
