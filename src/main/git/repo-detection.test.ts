import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGitRepoRoot, isGitRepo } from './repo'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('isGitRepo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-detect-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects directories with an invalid .git file', () => {
    const fakeRepo = path.join(tmpDir, 'fake')
    mkdirSync(fakeRepo)
    writeFileSync(path.join(fakeRepo, '.git'), 'not a gitdir file')

    expect(isGitRepo(fakeRepo)).toBe(false)
  })

  it('accepts bare git repositories', () => {
    const bareRepo = path.join(tmpDir, 'bare.git')
    git(tmpDir, ['init', '--bare', '--quiet', bareRepo])

    expect(isGitRepo(bareRepo)).toBe(true)
  })

  it('resolves a contained path to the worktree root', () => {
    const repoRoot = path.join(tmpDir, 'repo')
    const nestedDir = path.join(repoRoot, 'packages', 'web')
    mkdirSync(nestedDir, { recursive: true })
    git(tmpDir, ['init', '--quiet', repoRoot])

    // Why: derive the expected root from git's own --show-toplevel so the
    // assertion matches getGitRepoRoot's canonicalization (e.g. macOS resolves
    // the /var tmpdir symlink to /private/var) across all platforms.
    const expectedRoot = git(repoRoot, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')
    expect(getGitRepoRoot(nestedDir)).toBe(expectedRoot)
  })

  it('preserves bare repository paths when no worktree root exists', () => {
    const bareRepo = path.join(tmpDir, 'bare.git')
    git(tmpDir, ['init', '--bare', '--quiet', bareRepo])

    expect(getGitRepoRoot(bareRepo)).toBe(bareRepo)
  })
})
