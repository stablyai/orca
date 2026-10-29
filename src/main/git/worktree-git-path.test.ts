import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorktreeGitPath } from './worktree-git-path'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-worktree-git-path-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ROOTS = ['/mnt/', '/']
// The mapped Windows git dirs exist only on Windows; these tests stand them in.
const exists = (): boolean => true

describe('readWorktreeGitPath', () => {
  it("puts a main checkout's file in its .git folder", () => {
    mkdirSync(join(root, '.git'))
    expect(readWorktreeGitPath(root, 'orca/setup-runner.sh', ROOTS)).toMatch(
      /[\\/]\.git[\\/]orca[\\/]setup-runner\.sh$/
    )
  })

  it("maps a WSL-made link, under a custom mount root too, to the worktree's own git dir", () => {
    writeFileSync(join(root, '.git'), 'gitdir: /mnt/c/src/app/.git/worktrees/fix\n')
    expect(readWorktreeGitPath(root, 'orca/setup-runner.sh', ROOTS, exists)).toBe(
      String.raw`C:\src\app\.git\worktrees\fix\orca\setup-runner.sh`
    )
    writeFileSync(join(root, '.git'), 'gitdir: /c/src/app/.git/worktrees/fix\n')
    expect(readWorktreeGitPath(root, 'orca/x.sh', ROOTS, exists)).toBe(
      String.raw`C:\src\app\.git\worktrees\fix\orca\x.sh`
    )
  })

  it('keeps a Windows-made link and reads a missing or unreadable one as unknown', () => {
    writeFileSync(join(root, '.git'), 'gitdir: C:/src/app/.git/worktrees/fix\n')
    expect(readWorktreeGitPath(root, 'orca/x.sh', ROOTS, exists)).toBe(
      String.raw`C:\src\app\.git\worktrees\fix\orca\x.sh`
    )
    writeFileSync(join(root, '.git'), 'gitdir: /home/me/app/.git/worktrees/fix\n')
    expect(readWorktreeGitPath(root, 'orca/x.sh', ROOTS)).toBeNull()
    rmSync(join(root, '.git'))
    expect(readWorktreeGitPath(root, 'orca/x.sh', ROOTS)).toBeNull()
  })

  it('leaves common-dir paths to real Git', () => {
    mkdirSync(join(root, '.git'))
    for (const path of [
      'hooks/pre-commit',
      'info/exclude',
      'objects',
      'refs/heads/x',
      'config',
      'packed-refs'
    ]) {
      expect(readWorktreeGitPath(root, path, ROOTS)).toBeNull()
    }
    expect(readWorktreeGitPath(root, 'HEAD', ROOTS)).not.toBeNull()
  })

  it('leaves a stale or pruned link to real Git, rather than recreating its git dir', () => {
    const gitdir = join(root, 'repo', '.git', 'worktrees', 'fix')
    mkdirSync(join(root, 'wt'))
    // Relative, as Git writes with worktree.useRelativePaths; an absolute POSIX link would read as WSL's.
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: ../repo/.git/worktrees/fix\n')
    expect(readWorktreeGitPath(join(root, 'wt'), 'orca/x.sh', ROOTS)).toBeNull()
    mkdirSync(gitdir, { recursive: true })
    expect(readWorktreeGitPath(join(root, 'wt'), 'orca/x.sh', ROOTS)).toBe(
      join(gitdir, 'orca', 'x.sh')
    )
  })
})
