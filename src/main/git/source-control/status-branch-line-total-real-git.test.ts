import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git/status/git-branch-line-total'
import { getStatus } from './status-read'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

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

function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

const NO_LINES = { added: 0, removed: 0 }

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
    // Per-area counts sum to +2/-1 here, while the merge-base diff contains just +1/-0.
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

  it('omits the total when a deleted base file is recreated as untracked', async () => {
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
    expect(result.branchLineTotal).toBeUndefined()
  })
})
