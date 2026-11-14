import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGitRepoRoot, isGitRepo } from './repo-detection'

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

  it('rejects a symlink inside a repository that points outside when git cannot be run', () => {
    const realRepo = path.join(tmpDir, 'symlink-parent-real')
    const outsideDir = path.join(tmpDir, 'outside-target')
    const symlinkedOutsideDir = path.join(realRepo, 'links', 'outside')
    mkdirSync(path.dirname(symlinkedOutsideDir), { recursive: true })
    mkdirSync(outsideDir)
    git(realRepo, ['init', '--quiet'])
    symlinkSync(outsideDir, symlinkedOutsideDir, process.platform === 'win32' ? 'junction' : 'dir')

    withGitUnavailable(() => {
      expect(isGitRepo(symlinkedOutsideDir)).toBe(false)
    })
  })

  it('resolves a symlink from one repository into another to the real target repo', () => {
    const sourceRepo = path.join(tmpDir, 'symlink-source-real')
    const targetRepo = path.join(tmpDir, 'symlink-target-real')
    const targetNestedDir = path.join(targetRepo, 'packages', 'web')
    const symlinkedTargetDir = path.join(sourceRepo, 'links', 'target')
    mkdirSync(path.dirname(symlinkedTargetDir), { recursive: true })
    mkdirSync(targetNestedDir, { recursive: true })
    git(sourceRepo, ['init', '--quiet'])
    git(targetRepo, ['init', '--quiet'])
    symlinkSync(
      targetNestedDir,
      symlinkedTargetDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const expectedRoot = git(symlinkedTargetDir, ['rev-parse', '--show-toplevel'])
      .trim()
      .replace(/\\/g, '/')

    withGitUnavailable(() => {
      expect(isGitRepo(symlinkedTargetDir)).toBe(true)
      expect(getGitRepoRoot(symlinkedTargetDir)).toBe(expectedRoot)
    })
  })

  it('rejects a nested folder with an invalid .git marker even inside a valid repo', () => {
    const realRepo = path.join(tmpDir, 'outer-real')
    const nestedDir = path.join(realRepo, 'packages', 'web')
    mkdirSync(nestedDir, { recursive: true })
    git(realRepo, ['init', '--quiet'])
    writeFileSync(path.join(nestedDir, '.git'), 'not a gitdir file')

    withGitUnavailable(() => {
      expect(isGitRepo(nestedDir)).toBe(false)
    })
  })

  it('rejects a regular repository admin directory when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'admin-dir')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })
  })
})

/** Remove Git from PATH temporarily to exercise metadata fallback after a spawn failure. */
function withGitUnavailable(fn: () => void): void {
  const originalPath = process.env.PATH
  process.env.PATH = ''
  try {
    fn()
  } finally {
    // Assignment of undefined would corrupt PATH with the literal string.
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  }
}
