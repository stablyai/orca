import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKTREE_MERGE_REVIEW_STASH_MARKER,
  WORKTREE_MERGE_REVIEW_WSL_SYNC_UNSUPPORTED_MESSAGE
} from '../../shared/git-merge-review'
import { extractExecError } from './exec-error'
import { clearGitCapabilityStateForTests, getLocalGitCapabilityCache } from './git-capability-state'
import {
  acceptWorktreeMerge,
  getWorktreeMergeReviewState,
  rejectWorktreeMerge,
  resolveMainWorktreePath,
  syncWorktreeToMain
} from './worktree-merge-review'

// Why: real git state, because the whole flow is about what MERGE_HEAD and a stash do to a working tree.

const roots: string[] = []

afterEach(async () => {
  clearGitCapabilityStateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function tryGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    return { ok: true, stdout: git(cwd, args), stderr: '' }
  } catch (error) {
    return { ok: false, ...extractExecError(error) }
  }
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  await writeFile(join(root, relativePath), contents)
}

/** `rev-parse -q --verify` answers through its exit code, so absence is not an error here. */
function isMergePending(repo: string): boolean {
  return tryGit(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok
}

async function fixture(): Promise<{ repo: string; worktree: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-merge-review-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const worktree = join(root, 'feature-wt')
  git(root, ['init', '--quiet', repo])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'test@test.com'])
  git(repo, ['config', 'user.name', 'Test'])
  await write(repo, 'base.txt', 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'initial'])
  git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
  return { repo, worktree }
}

function stashSubjects(repo: string): string[] {
  return git(repo, ['stash', 'list', '--format=%gs']).split('\n').filter(Boolean)
}

describe('resolveMainWorktreePath', () => {
  it('finds the main checkout from a linked worktree', async () => {
    const { repo, worktree } = await fixture()
    expect(await resolveMainWorktreePath(worktree)).toBe(await realpath(repo))
  })
})

describe('syncWorktreeToMain', () => {
  it('merges the branch into the main checkout without committing', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '--quiet', '-m', 'feature work'])

    const outcome = await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    expect(outcome).toMatchObject({ kind: 'merged', branch: 'feature', targetBranch: 'main' })
    expect(isMergePending(repo)).toBe(true)
    expect(git(repo, ['diff', '--cached', '--name-only', 'HEAD']).trim()).toBe('feature.txt')
    expect(await getWorktreeMergeReviewState(repo)).toEqual({
      phase: 'pending',
      branch: 'feature',
      conflicts: []
    })
  })

  it('carries uncommitted changes through a snapshot without touching the worktree', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'draft.md', 'draft\n')

    const outcome = await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    expect(outcome).toMatchObject({ kind: 'merged', includedUncommittedChanges: true })
    expect(git(repo, ['diff', '--cached', '--name-only', 'HEAD']).trim()).toBe('draft.md')
    // The worktree keeps its own uncommitted state, and the snapshot commit never lands on its branch.
    expect(git(worktree, ['status', '--porcelain', '--untracked-files=all']).trim()).toBe(
      '?? draft.md'
    )
    expect(git(worktree, ['log', '--format=%s', 'feature']).trim()).toBe('initial')
  })

  it('parks the main checkout’s own changes in a marked stash', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await write(repo, 'base.txt', 'edited while reviewing\n')

    const outcome = await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    expect(outcome).toMatchObject({ kind: 'merged', stashedMainChanges: true })
    expect(stashSubjects(repo)).toHaveLength(1)
    expect(stashSubjects(repo)[0]).toContain(
      `${WORKTREE_MERGE_REVIEW_STASH_MARKER}: auto-stash before syncing feature`
    )
    expect(git(repo, ['show', 'HEAD:base.txt'])).toBe('base\n')
  })

  it('reports conflicts and leaves them unresolved in the main checkout', async () => {
    const { repo, worktree } = await fixture()
    await write(repo, 'base.txt', 'main side\n')
    git(repo, ['commit', '--quiet', '-am', 'main side'])
    await write(worktree, 'base.txt', 'feature side\n')
    git(worktree, ['commit', '--quiet', '-am', 'feature side'])

    const outcome = await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    expect(outcome).toMatchObject({ kind: 'merged', conflicts: ['base.txt'], stat: '' })
    expect(await getWorktreeMergeReviewState(repo)).toMatchObject({
      phase: 'pending',
      conflicts: ['base.txt']
    })
  })

  it('reports nothing to merge when the branch is already contained', async () => {
    const { repo, worktree } = await fixture()
    expect(await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })).toEqual({
      kind: 'nothing-to-merge',
      branch: 'feature',
      targetBranch: 'main'
    })
    expect(isMergePending(repo)).toBe(false)
  })

  it('refuses a second sync while a review is pending', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    await expect(
      syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    ).rejects.toThrow(/already has a merge awaiting review/)
  })

  it('reports nothing to merge when an accepted review left the worktree unchanged', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'draft.md', 'draft\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    await acceptWorktreeMerge(repo)

    // The worktree still holds the same uncommitted change, so the new snapshot
    // commit has a new id but the tree the main checkout already has.
    expect(await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })).toEqual({
      kind: 'nothing-to-merge',
      branch: 'feature',
      targetBranch: 'main'
    })
    expect(isMergePending(repo)).toBe(false)
  })

  it('refuses to sync a WSL project at the snapshot boundary', async () => {
    const { repo, worktree } = await fixture()
    await expect(
      syncWorktreeToMain(
        { worktreePath: worktree, mainWorktreePath: repo },
        { wslDistro: 'Ubuntu' }
      )
    ).rejects.toThrow(WORKTREE_MERGE_REVIEW_WSL_SYNC_UNSUPPORTED_MESSAGE)
  })
})

describe('acceptWorktreeMerge', () => {
  it('commits the merge and restores the parked changes', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await write(repo, 'base.txt', 'edited while reviewing\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    const outcome = await acceptWorktreeMerge(repo)

    expect(outcome).toMatchObject({ kind: 'committed' })
    expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe("Merge branch 'feature'")
    expect(isMergePending(repo)).toBe(false)
    expect(stashSubjects(repo)).toEqual([])
    expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('edited while reviewing\n')
  })

  it('blocks unresolved conflicts, unstaged edits and leftover markers', async () => {
    const { repo, worktree } = await fixture()
    await write(repo, 'base.txt', 'main side\n')
    git(repo, ['commit', '--quiet', '-am', 'main side'])
    await write(worktree, 'base.txt', 'feature side\n')
    git(worktree, ['commit', '--quiet', '-am', 'feature side'])
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    await expect(acceptWorktreeMerge(repo)).rejects.toThrow(/Unresolved conflicts remain/)

    await write(
      repo,
      'base.txt',
      '<<<<<<< HEAD\nmain side\n=======\nfeature side\n>>>>>>> feature\n'
    )
    git(repo, ['add', 'base.txt'])
    await expect(acceptWorktreeMerge(repo)).rejects.toThrow(/Conflict markers remain/)

    await write(repo, 'base.txt', 'resolved\n')
    await expect(acceptWorktreeMerge(repo)).rejects.toThrow(/unstaged changes/)

    git(repo, ['add', 'base.txt'])
    await expect(acceptWorktreeMerge(repo)).resolves.toMatchObject({ kind: 'committed' })
  })

  it('accepts an explicit commit message', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    await acceptWorktreeMerge(repo, {}, 'merge feature by hand')

    expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe('merge feature by hand')
  })
})

describe('rejectWorktreeMerge', () => {
  it('aborts a clean review without asking, restoring the parked changes', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await write(repo, 'base.txt', 'edited while reviewing\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    await expect(rejectWorktreeMerge(repo)).resolves.toEqual({ kind: 'rejected' })

    expect(isMergePending(repo)).toBe(false)
    expect(git(repo, ['diff', '--cached', '--name-only', 'HEAD']).trim()).toBe('')
    expect(stashSubjects(repo)).toEqual([])
    expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('edited while reviewing\n')
  })

  it('asks before discarding hand edits, then discards only those', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    await write(repo, 'hand-edited.md', 'review notes\n')
    await write(repo, 'base.txt', 'tweaked during review\n')

    const outcome = await rejectWorktreeMerge(repo)

    // Only the hand edits are listed — never the merged content itself.
    if (outcome.kind !== 'needs-confirmation') {
      throw new Error(`expected a confirmation prompt, got ${outcome.kind}`)
    }
    expect(outcome.paths).toContain('base.txt')
    expect(outcome.paths).not.toContain('feature.txt')

    await expect(rejectWorktreeMerge(repo, {}, true)).resolves.toEqual({ kind: 'rejected' })

    expect(isMergePending(repo)).toBe(false)
    expect(git(repo, ['diff', '--cached', '--name-only', 'HEAD']).trim()).toBe('')
    expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('base\n')
    // Untracked files are never part of a merge or a hard reset.
    expect(await readFile(join(repo, 'hand-edited.md'), 'utf-8')).toBe('review notes\n')
  })

  it('lists conflicted files as hand edits, and clears them on confirmation', async () => {
    const { repo, worktree } = await fixture()
    await write(repo, 'base.txt', 'main side\n')
    git(repo, ['commit', '--quiet', '-am', 'main side'])
    await write(worktree, 'base.txt', 'feature side\n')
    git(worktree, ['commit', '--quiet', '-am', 'feature side'])
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })

    expect(await rejectWorktreeMerge(repo)).toEqual({
      kind: 'needs-confirmation',
      paths: ['base.txt']
    })
    await expect(rejectWorktreeMerge(repo, {}, true)).resolves.toEqual({ kind: 'rejected' })
    expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('main side\n')
    expect(isMergePending(repo)).toBe(false)
  })

  it('asks before discarding a staged hand edit', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    await write(repo, 'notes.md', 'review notes\n')
    git(repo, ['add', 'notes.md'])

    const outcome = await rejectWorktreeMerge(repo)

    // Why: merge --abort discards staged changes, so the prompt is the only warning.
    if (outcome.kind !== 'needs-confirmation') {
      throw new Error(`expected a confirmation prompt, got ${outcome.kind}`)
    }
    expect(outcome.paths).toEqual(['notes.md'])

    await expect(rejectWorktreeMerge(repo, {}, true)).resolves.toEqual({ kind: 'rejected' })
    expect(isMergePending(repo)).toBe(false)
  })

  it('asks before discarding a staged edit to a file the merge touched', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    if (!tryGit(repo, ['merge-tree', '--write-tree', '--no-messages', 'HEAD', 'MERGE_HEAD']).ok) {
      return // Git < 2.38: the fallback cannot distinguish this case.
    }
    await write(repo, 'feature.txt', 'feature plus a hand edit\n')
    git(repo, ['add', 'feature.txt'])

    const outcome = await rejectWorktreeMerge(repo)

    if (outcome.kind !== 'needs-confirmation') {
      throw new Error(`expected a confirmation prompt, got ${outcome.kind}`)
    }
    expect(outcome.paths).toContain('feature.txt')
  })

  it('still lists a staged hand edit when merge-tree is unavailable', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    getLocalGitCapabilityCache({ cwd: repo }).rememberUnsupported('merge-tree-write-tree')
    await write(repo, 'notes.md', 'review notes\n')
    git(repo, ['add', 'notes.md'])

    const outcome = await rejectWorktreeMerge(repo)

    if (outcome.kind !== 'needs-confirmation') {
      throw new Error(`expected a confirmation prompt, got ${outcome.kind}`)
    }
    expect(outcome.paths).toContain('notes.md')
  })

  it('asks before discarding a staged conflict resolution', async () => {
    const { repo, worktree } = await fixture()
    await write(repo, 'base.txt', 'main side\n')
    git(repo, ['commit', '--quiet', '-am', 'main side'])
    await write(worktree, 'base.txt', 'feature side\n')
    git(worktree, ['commit', '--quiet', '-am', 'feature side'])
    await syncWorktreeToMain({ worktreePath: worktree, mainWorktreePath: repo })
    await write(repo, 'base.txt', 'resolved by hand\n')
    git(repo, ['add', 'base.txt'])

    const outcome = await rejectWorktreeMerge(repo)

    // Why: merge --abort discards the staged resolution, so the prompt is the only warning.
    if (outcome.kind !== 'needs-confirmation') {
      throw new Error(`expected a confirmation prompt, got ${outcome.kind}`)
    }
    expect(outcome.paths).toContain('base.txt')
  })

  it('refuses when nothing is awaiting review', async () => {
    const { repo } = await fixture()
    await expect(rejectWorktreeMerge(repo)).rejects.toThrow(/no merge awaiting review/)
  })
})

describe('getWorktreeMergeReviewState', () => {
  it('reports sync as unsupported for a WSL project', async () => {
    const { repo } = await fixture()
    expect(await getWorktreeMergeReviewState(repo, { wslDistro: 'Ubuntu' })).toEqual({
      phase: 'idle',
      syncSupported: false
    })
  })

  it('is idle for a main checkout with no pending merge', async () => {
    const { repo } = await fixture()
    expect(await getWorktreeMergeReviewState(repo)).toEqual({
      phase: 'idle',
      syncSupported: true
    })
  })

  it('reads state a terminal `wf sync` left behind', async () => {
    const { repo, worktree } = await fixture()
    await write(worktree, 'feature.txt', 'feature\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '--quiet', '-m', 'feature work'])
    // Same state the standalone tool produces: an uncommitted merge started from the branch.
    git(repo, ['merge', '--no-ff', '--no-commit', '-m', "Merge branch 'feature'", 'feature'])

    expect(await getWorktreeMergeReviewState(repo)).toEqual({
      phase: 'pending',
      branch: 'feature',
      conflicts: []
    })
    expect(isMergePending(repo)).toBe(true)
  })
})
