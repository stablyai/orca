import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import '../../../../shared/worktree/base-ref'
import { searchBaseRefDetails } from './repo-base-ref-search'

// Real Git exercises ref globs that mocks cannot validate.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet'])
  // symbolic-ref selects main before the first commit on Git < 2.28 too.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.email', 'test@test.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['commit', '--allow-empty', '-m', 'initial', '--quiet'])
}

function createRemoteRef(mainDir: string, shortName: string, sha: string): void {
  git(mainDir, ['update-ref', `refs/remotes/${shortName}`, sha])
}

function getHeadSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

describe('searchBaseRefs (widened glob)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-test-'))
    initRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates worktrees from intact local and remote Unicode search selectors', async () => {
    const branch = 'feature/加'
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['branch', branch])
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, `origin/${branch}`, sha)
    const results = await searchBaseRefDetails(tmpDir, '加')
    expect(results).toHaveLength(2)
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'orca-unicode-worktrees-'))
    try {
      for (const [index, result] of results.entries()) {
        const worktreePath = path.join(worktreeRoot, String(index))
        git(tmpDir, ['worktree', 'add', '-b', `recovered-${index}`, worktreePath, result.refName])
        expect(git(worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(sha)
        expect(result.localBranchName).toBe(branch)
      }
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true })
      git(tmpDir, ['worktree', 'prune'])
    }
  })

  it('resolves a Unicode branch rather than a same-name tag', async () => {
    const branch = 'feature/运动记录及预约详情页优化'
    const branchSha = getHeadSha(tmpDir)
    git(tmpDir, ['branch', branch, branchSha])
    git(tmpDir, ['commit', '--allow-empty', '-m', 'tag target', '--quiet'])
    git(tmpDir, ['tag', branch])

    const results = await searchBaseRefDetails(tmpDir, '运动记录')

    expect(results).toHaveLength(1)
    expect(results[0]?.refName).toBe(`refs/heads/${branch}`)
    expect(results[0]?.localBranchName).toBe(branch)
    expect(git(tmpDir, ['rev-parse', '--verify', results[0]?.refName ?? '']).trim()).toBe(branchSha)

    const worktreeDir = mkdtempSync(path.join(tmpdir(), 'orca-ref-worktree-test-'))
    rmSync(worktreeDir, { recursive: true })
    try {
      git(tmpDir, ['worktree', 'add', '--quiet', worktreeDir, results[0]?.localBranchName ?? ''])
      expect(git(worktreeDir, ['symbolic-ref', 'HEAD']).trim()).toBe(`refs/heads/${branch}`)
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true })
      git(tmpDir, ['worktree', 'prune'])
    }
  })
})
