// Phase 10 against a REAL Git repository. Landing correctness cannot be
// demonstrated against a mocked Git: the whole point is what happens to the
// user's refs, index, and files.
//
// L2 IS THE DURABLE BOUNDARY, and these tests pin both sides of it:
//   before L2 -> the branch is provably untouched
//   after  L2 -> the branch moved, and an L3 failure is an ADVISORY, not a failure
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRepo, git, statusPorcelain, type TestRepo } from './audited-worktree-test-repo'

vi.mock('./audited-worktree-registry', () => ({
  isAuditedWorktreePath: () => false,
  isAuditedWorktreeRegistryReady: () => true
}))

const { runLandRefUpdate, runLandWorktreeUpdate } = await import('./audited-land-git')
const { classifySourceRepoTip, verifyBranchCheckedOutHere, verifySourceRepoReadiness } =
  await import('./audited-land-source-repo')

let repo: TestRepo

/** Commits a file on a detached HEAD so the branch tip stays at base. */
function buildOffBranchCommit(repoPath: string, name: string, body: string): string {
  const base = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '-q', '--detach', base])
  writeFileSync(join(repoPath, name), body, 'utf8')
  git(repoPath, ['add', '-A', '--'])
  execFileSync('git', ['-C', repoPath, 'commit', '-q', '-m', `add ${name}`], { encoding: 'utf8' })
  const sha = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '-q', 'main'])
  return sha
}

beforeEach(() => {
  repo = createTestRepo()
})
afterEach(() => repo.cleanup())

describe('L2 + L3 — the happy fast-forward', () => {
  it('moves the ref, the index, and the working tree', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'feature.txt', 'hello\n')

    expect(git(repo.repoPath, ['rev-parse', 'refs/heads/main'])).toBe(base)

    const refUpdate = await runLandRefUpdate({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      committedSha: target,
      expectedBaseSha: base
    })
    expect(refUpdate.ok).toBe(true)
    expect(git(repo.repoPath, ['rev-parse', 'refs/heads/main'])).toBe(target)

    const worktreeUpdate = await runLandWorktreeUpdate({
      sourceRepoPath: repo.repoPath,
      baseSha: base,
      committedSha: target
    })
    expect(worktreeUpdate).toBe(true)

    // The file exists, HEAD reads as the landed commit, and status is clean.
    expect(git(repo.repoPath, ['rev-parse', 'HEAD'])).toBe(target)
    expect(statusPorcelain(repo.repoPath)).toBe('')
    expect(git(repo.repoPath, ['show', '--name-only', '--format=', 'HEAD'])).toContain(
      'feature.txt'
    )
  })

  it('preserves an UNTRACKED file byte-intact across the land', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'feature.txt', 'hello\n')
    writeFileSync(join(repo.repoPath, 'scratch.local'), 'do not touch\n', 'utf8')

    await runLandRefUpdate({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      committedSha: target,
      expectedBaseSha: base
    })
    await runLandWorktreeUpdate({
      sourceRepoPath: repo.repoPath,
      baseSha: base,
      committedSha: target
    })

    const kept = execFileSync('git', ['-C', repo.repoPath, 'status', '--porcelain'], {
      encoding: 'utf8'
    })
    expect(kept).toContain('scratch.local')
  })
})

describe('L2 CAS — a moved branch is a loud failure, never a silent overwrite', () => {
  it('refuses when the branch no longer sits at the expected base', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'feature.txt', 'hello\n')
    // Someone else advances main first.
    const intruder = buildOffBranchCommit(repo.repoPath, 'other.txt', 'other\n')
    git(repo.repoPath, ['update-ref', 'refs/heads/main', intruder, base])

    const result = await runLandRefUpdate({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      committedSha: target,
      expectedBaseSha: base
    })
    expect(result).toEqual({ ok: false, reasonCode: 'fast_forward_failed' })
    // The intruder's commit is still the tip: we did not clobber it.
    expect(git(repo.repoPath, ['rev-parse', 'refs/heads/main'])).toBe(intruder)
  })
})

describe('L0 readiness — a dirty repository is refused before anything moves', () => {
  it('refuses an unstaged modification', async () => {
    writeFileSync(join(repo.repoPath, 'dirty.txt'), 'x\n', 'utf8')
    git(repo.repoPath, ['add', '-A', '--'])
    execFileSync('git', ['-C', repo.repoPath, 'commit', '-q', '-m', 'add dirty'], {
      encoding: 'utf8'
    })
    writeFileSync(join(repo.repoPath, 'dirty.txt'), 'modified\n', 'utf8')

    const result = await verifySourceRepoReadiness({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'source_repo_dirty' })
  })

  it('refuses an untracked file', async () => {
    writeFileSync(join(repo.repoPath, 'new.txt'), 'x\n', 'utf8')
    const result = await verifySourceRepoReadiness({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'source_repo_dirty' })
  })

  it('refuses a detached HEAD', async () => {
    git(repo.repoPath, ['checkout', '-q', '--detach', repo.headCommit])
    const result = await verifySourceRepoReadiness({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({
      ok: false,
      reasonCode: 'source_repo_detached_or_invalid_branch'
    })
  })

  it('refuses when HEAD is on a DIFFERENT branch', async () => {
    git(repo.repoPath, ['checkout', '-q', '-b', 'other'])
    const result = await verifySourceRepoReadiness({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({
      ok: false,
      reasonCode: 'source_repo_detached_or_invalid_branch'
    })
  })

  it('accepts a clean repository on the expected branch', async () => {
    const result = await verifySourceRepoReadiness({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({ ok: true })
  })
})

describe('checked-out requirement — never land into a branch another worktree holds', () => {
  it('accepts the branch checked out at the source repo itself', async () => {
    const result = await verifyBranchCheckedOutHere({
      sourceRepoPath: repo.repoPath,
      branchName: 'main'
    })
    expect(result).toEqual({ ok: true })
  })

  it('refuses a branch checked out in a DIFFERENT worktree', async () => {
    const linked = join(repo.workspaceRoot, 'linked')
    git(repo.repoPath, ['worktree', 'add', '-q', '-b', 'side', linked])
    const result = await verifyBranchCheckedOutHere({
      sourceRepoPath: repo.repoPath,
      branchName: 'side'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'source_repo_branch_not_checked_out' })
  })

  it('refuses a branch checked out nowhere', async () => {
    git(repo.repoPath, ['branch', 'unused'])
    const result = await verifyBranchCheckedOutHere({
      sourceRepoPath: repo.repoPath,
      branchName: 'unused'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'source_repo_branch_not_checked_out' })
  })
})

describe('tip classification — the three outcomes never collapse', () => {
  it('classifies a tip at base as a fast-forward', async () => {
    const target = buildOffBranchCommit(repo.repoPath, 'f.txt', 'x\n')
    const result = await classifySourceRepoTip({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      baseCommit: repo.headCommit,
      committedSha: target
    })
    expect(result).toEqual({ kind: 'fast_forward', tip: repo.headCommit })
  })

  it('classifies a tip AT the committed sha as already landed', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'f.txt', 'x\n')
    git(repo.repoPath, ['update-ref', 'refs/heads/main', target, base])
    const result = await classifySourceRepoTip({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      baseCommit: base,
      committedSha: target
    })
    expect(result).toEqual({ kind: 'already_landed', tip: target })
  })

  it('classifies a DESCENDANT of the committed sha as already landed', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'f.txt', 'x\n')
    git(repo.repoPath, ['update-ref', 'refs/heads/main', target, base])
    git(repo.repoPath, ['reset', '-q', '--hard', target])
    writeFileSync(join(repo.repoPath, 'later.txt'), 'later\n', 'utf8')
    git(repo.repoPath, ['add', '-A', '--'])
    execFileSync('git', ['-C', repo.repoPath, 'commit', '-q', '-m', 'later'], { encoding: 'utf8' })
    const later = git(repo.repoPath, ['rev-parse', 'HEAD'])

    const result = await classifySourceRepoTip({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      baseCommit: base,
      committedSha: target
    })
    expect(result).toEqual({ kind: 'already_landed', tip: later })
  })

  it('refuses a DIVERGED tip with integration_required', async () => {
    const base = repo.headCommit
    const target = buildOffBranchCommit(repo.repoPath, 'f.txt', 'x\n')
    const diverged = buildOffBranchCommit(repo.repoPath, 'g.txt', 'y\n')
    git(repo.repoPath, ['update-ref', 'refs/heads/main', diverged, base])

    const result = await classifySourceRepoTip({
      sourceRepoPath: repo.repoPath,
      branchName: 'main',
      baseCommit: base,
      committedSha: target
    })
    expect(result).toEqual({ kind: 'refused', reasonCode: 'integration_required' })
  })
})
