import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invalidateGitBranchLineTotalInFlight } from '../../shared/git-branch-line-total'
import { getStatus, invalidateGitReadCaches } from './status'

const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-line-total-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  return repo
}

async function write(repo: string, relativePath: string, contents: string | Buffer): Promise<void> {
  const target = path.join(repo, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

/** The forked-from commit the chip measures against, as branch compare would resolve it. */
function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

// No fixture path here looks like test or generated code, so it is all source.
const NO_LINES = { added: 0, removed: 0 }

/** What a plain `git diff <mergeBase>` reports, i.e. the number the chip must not disagree with. */
function rangedDiffTotal(repo: string, mergeBase: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of git(repo, ['diff', '--numstat', '-M', mergeBase, '--']).split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const [rawAdded, rawRemoved] = line.split('\t')
    added += rawAdded === '-' ? 0 : Number.parseInt(rawAdded ?? '0', 10)
    removed += rawRemoved === '-' ? 0 : Number.parseInt(rawRemoved ?? '0', 10)
  }
  return { added, removed }
}

beforeEach(() => {
  invalidateGitReadCaches()
  invalidateGitBranchLineTotalInFlight()
})

afterEach(async () => {
  invalidateGitReadCaches()
  invalidateGitBranchLineTotalInFlight()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('branch line total against a real repository', () => {
  it('measures a partially staged line once, not once per status area', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'f.txt', 'line1\n')
    const mergeBase = commitAll(repo, 'base')
    // Stage "+foo", then edit that same line to "bar" without staging it: the
    // per-area rows read +1/-0 staged and +1/-1 unstaged, summing to +2/-1.
    await write(repo, 'f.txt', 'line1\nfoo\n')
    git(repo, ['add', 'f.txt'])
    await write(repo, 'f.txt', 'line1\nbar\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(rangedDiffTotal(repo, mergeBase)).toEqual({ added: 1, removed: 0 })
    expect(result.branchLineTotal).toEqual({
      added: 1,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
    expect(result.entries.map((entry) => [entry.area, entry.added, entry.removed])).toEqual([
      ['staged', 1, 0],
      ['unstaged', 1, 1]
    ])
  })

  it('nets a line added in a branch commit and deleted in the working tree to zero', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'f.txt', 'a\n')
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'f.txt', 'a\nb\n')
    commitAll(repo, 'add b')
    await write(repo, 'f.txt', 'a\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(result.branchLineTotal).toEqual({
      added: 0,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('keeps the total across a commit and updates it on the next status call after an edit', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'f.txt', 'a\n')
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'f.txt', 'a\nb\nc\n')

    const beforeCommit = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    expect(beforeCommit.branchLineTotal).toEqual({
      added: 2,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })

    commitAll(repo, 'commit the edit')
    const afterCommit = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    expect(afterCommit.branchLineTotal).toEqual({
      added: 2,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })

    await write(repo, 'f.txt', 'a\nb\nc\nd\n')
    const afterSecondEdit = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    expect(afterSecondEdit.branchLineTotal).toEqual({
      added: 3,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('counts a rename across the commit boundary once, using the post-rename path', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'old.txt', 'a\nb\nc\nd\ne\n')
    const mergeBase = commitAll(repo, 'base')
    git(repo, ['mv', 'old.txt', 'new.txt'])
    commitAll(repo, 'rename')
    await write(repo, 'new.txt', 'a\nb\nc\nd\ne\nf\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(rangedDiffTotal(repo, mergeBase)).toEqual({ added: 1, removed: 0 })
    expect(result.branchLineTotal).toEqual({
      added: 1,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('counts an untracked-only branch from the untracked file contents', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'kept.txt', 'a\n')
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'src/new.ts', 'one\ntwo\nthree\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(result.entries.map((entry) => entry.area)).toEqual(['untracked'])
    expect(result.branchLineTotal).toEqual({
      added: 3,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('excludes a binary-only change, matching numstat reporting it as "-"', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'blob.bin', Buffer.from([0, 1, 2, 3, 10, 65, 66]))
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'blob.bin', Buffer.from([0, 9, 10, 11, 12, 67, 68, 69, 70]))

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(git(repo, ['diff', '--numstat', mergeBase, '--'])).toMatch(/^-\t-\t/)
    expect(result.branchLineTotal).toEqual({
      added: 0,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('contributes nothing for a pure rename', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'f.txt', 'a\nb\nc\nd\n')
    const mergeBase = commitAll(repo, 'base')
    git(repo, ['mv', 'f.txt', 'g.txt'])

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(result.branchLineTotal).toEqual({
      added: 0,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('splits test-path and generated files out of the published total', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'src/a.ts', 'a\n')
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'src/a.ts', 'a\nb\n')
    await write(repo, 'src/a.test.ts', 't1\nt2\nt3\n')
    await write(repo, 'pnpm-lock.yaml', 'l1\nl2\nl3\nl4\nl5\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(rangedDiffTotal(repo, mergeBase)).toEqual({ added: 1, removed: 0 })
    expect(result.branchLineTotal).toEqual({
      added: 9,
      removed: 0,
      mergeBase,
      test: { added: 3, removed: 0 },
      generated: { added: 5, removed: 0 }
    })
  })

  it('includes untracked additions alongside tracked range changes', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'f.txt', 'a\nb\n')
    const mergeBase = commitAll(repo, 'base')
    await write(repo, 'f.txt', 'a\nb\nc\n')
    commitAll(repo, 'append c')
    await write(repo, 'untracked.txt', 'u1\nu2\nu3\nu4\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(rangedDiffTotal(repo, mergeBase)).toEqual({ added: 1, removed: 0 })
    expect(result.branchLineTotal).toEqual({
      added: 5,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  // Documented deviation from a pure `git diff`: the untracked half is added on
  // top of the tracked range, so a deleted-then-recreated path is counted twice.
  // Locked in deliberately — changing it must be a deliberate spec change.
  it('counts both the deletion and the recreated untracked file for the same path', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'gone.txt', 'a\nb\nc\n')
    const mergeBase = commitAll(repo, 'base')
    git(repo, ['rm', '-q', 'gone.txt'])
    commitAll(repo, 'delete gone.txt')
    await write(repo, 'gone.txt', 'n1\nn2\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase })

    expect(result.entries.map((entry) => [entry.area, entry.path])).toEqual([
      ['untracked', 'gone.txt']
    ])
    expect(rangedDiffTotal(repo, mergeBase)).toEqual({ added: 0, removed: 3 })
    expect(result.branchLineTotal).toEqual({
      added: 2,
      removed: 3,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
  })
})
