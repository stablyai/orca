import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, afterEach } from 'vitest'
import { canonicalizeLocalWorktreeCreationPath } from './worktree-creation-path'

describe('canonicalizeLocalWorktreeCreationPath', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.toReversed()) {
      rmSync(dir, { recursive: true, force: true })
    }
    cleanupDirs.length = 0
  })

  it('resolves a missing descendant beneath a directory symlink to the real ancestor and preserves the tail', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'orca-real-'))
    const linkRoot = mkdtempSync(join(tmpdir(), 'orca-link-'))
    cleanupDirs.push(realRoot, linkRoot)

    // Create realRoot/repo as the nearest existing ancestor for the symlink target.
    mkdirSync(join(realRoot, 'repo'), { recursive: true })
    const linkPath = join(linkRoot, 'repo-link')
    symlinkSync(realRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    // target: <linkRoot>/repo-link/repo/feature  (repo-link is a symlink, feature is missing)
    const target = join(linkPath, 'repo', 'feature')
    const result = canonicalizeLocalWorktreeCreationPath(target)

    // The real ancestor is realRoot/repo (exists), and the missing tail is 'feature'.
    const expected = join(realRoot, 'repo', 'feature')
    expect(result).toBe(expected)
  })

  it('returns the target unchanged when it sits beneath a normal canonical existing ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-canonical-'))
    cleanupDirs.push(root)

    const target = join(root, 'feature')
    const result = canonicalizeLocalWorktreeCreationPath(target)

    // root exists, no symlinks involved, path is already canonical.
    expect(result).toBe(target)
  })

  it('returns WSL UNC paths unchanged', () => {
    const winUnc = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\worktrees\\feature'
    const winDollarUnc = '//wsl$/Ubuntu/home/dev/worktrees/feature'

    expect(canonicalizeLocalWorktreeCreationPath(winUnc)).toBe(winUnc)
    expect(canonicalizeLocalWorktreeCreationPath(winDollarUnc)).toBe(winDollarUnc)
  })
})
