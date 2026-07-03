import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGitRepoRoot, isGitRepo, normalizeGitRepoRootForInputPath } from './repo'

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

  it('accepts a real repository when git itself cannot be run', () => {
    // Why: regression guard for the spurious "Open as Folder" prompt. When the
    // `git rev-parse` probe fails for an environmental reason (here simulated by
    // making `git` unresolvable), a directory carrying valid Git metadata must
    // still be recognized rather than silently downgraded to a plain folder.
    const realRepo = path.join(tmpDir, 'real')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])

    withGitUnavailable(() => {
      expect(isGitRepo(realRepo)).toBe(true)
    })
  })

  it('accepts a nested directory in a repository when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'nested-real')
    const nestedDir = path.join(realRepo, 'packages', 'web')
    mkdirSync(nestedDir, { recursive: true })
    git(realRepo, ['init', '--quiet'])

    withGitUnavailable(() => {
      expect(isGitRepo(nestedDir)).toBe(true)
    })
  })

  it('resolves a nested directory to the repo root when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'nested-root-real')
    const nestedDir = path.join(realRepo, 'packages', 'web')
    mkdirSync(nestedDir, { recursive: true })
    git(realRepo, ['init', '--quiet'])

    withGitUnavailable(() => {
      expect(getGitRepoRoot(nestedDir)).toBe(realRepo)
    })
  })

  it('accepts a symlinked nested directory in a repository when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'symlink-real')
    const nestedDir = path.join(realRepo, 'packages', 'web')
    const symlinkedNestedDir = path.join(tmpDir, 'linked-nested')
    mkdirSync(nestedDir, { recursive: true })
    git(realRepo, ['init', '--quiet'])
    symlinkSync(nestedDir, symlinkedNestedDir, process.platform === 'win32' ? 'junction' : 'dir')

    withGitUnavailable(() => {
      expect(isGitRepo(symlinkedNestedDir)).toBe(true)
      expect(getGitRepoRoot(symlinkedNestedDir)).toBe(
        realpathSync.native(realRepo).replace(/\\/g, '/')
      )
    })
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

  it('accepts a linked worktree when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'linked-main')
    const linkedWorktree = path.join(tmpDir, 'linked-worktree')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    git(realRepo, [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca@example.com',
      'commit',
      '--allow-empty',
      '--message',
      'initial'
    ])
    git(realRepo, ['worktree', 'add', '--quiet', '-b', 'offline-linked', linkedWorktree])

    withGitUnavailable(() => {
      expect(isGitRepo(linkedWorktree)).toBe(true)
    })
  })

  it('rejects a plain folder when git cannot be run', () => {
    const plain = path.join(tmpDir, 'plain')
    mkdirSync(plain)

    withGitUnavailable(() => {
      expect(isGitRepo(plain)).toBe(false)
    })
  })

  it('rejects a garbage .git file even when git cannot be run', () => {
    const fakeRepo = path.join(tmpDir, 'fake-offline')
    mkdirSync(fakeRepo)
    writeFileSync(path.join(fakeRepo, '.git'), 'not a gitdir file')

    withGitUnavailable(() => {
      expect(isGitRepo(fakeRepo)).toBe(false)
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

  it('rejects a .git file that points at a missing gitdir when git cannot be run', () => {
    const fakeRepo = path.join(tmpDir, 'missing-gitdir')
    mkdirSync(fakeRepo)
    writeFileSync(path.join(fakeRepo, '.git'), 'gitdir: /missing/orca/gitdir')

    withGitUnavailable(() => {
      expect(isGitRepo(fakeRepo)).toBe(false)
    })
  })

  it('rejects an empty .git directory', () => {
    const emptyGitDir = path.join(tmpDir, 'empty-gitdir')
    mkdirSync(path.join(emptyGitDir, '.git'), { recursive: true })

    withGitUnavailable(() => {
      expect(isGitRepo(emptyGitDir)).toBe(false)
    })
  })

  it('rejects an incomplete .git directory with only HEAD', () => {
    const incompleteGitDir = path.join(tmpDir, 'incomplete-gitdir')
    mkdirSync(path.join(incompleteGitDir, '.git'), { recursive: true })
    writeFileSync(path.join(incompleteGitDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    withGitUnavailable(() => {
      expect(isGitRepo(incompleteGitDir)).toBe(false)
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

  it('rejects a case-insensitive .git admin directory alias when git itself cannot be run', () => {
    const realRepo = path.join(tmpDir, 'admin-dir-uppercase')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    const uppercaseAdminDir = path.join(realRepo, '.GIT')
    try {
      realpathSync.native(uppercaseAdminDir)
    } catch {
      return
    }

    withGitUnavailable(() => {
      expect(isGitRepo(uppercaseAdminDir)).toBe(false)
    })
  })

  it('rejects a regular repository admin directory when core.bare uses alternate false spelling', () => {
    const realRepo = path.join(tmpDir, 'admin-dir-no')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    git(realRepo, ['config', 'core.bare', 'no'])

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })
  })

  it('rejects a regular repository admin directory when core.bare is empty false', () => {
    const realRepo = path.join(tmpDir, 'admin-dir-empty-false')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    const configPath = path.join(realRepo, '.git', 'config')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/bare = false/, 'bare ='))

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })
  })

  it('rejects a regular repository admin directory when core.bare false has inline comments', () => {
    const realRepo = path.join(tmpDir, 'admin-dir-commented-false')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    const configPath = path.join(realRepo, '.git', 'config')
    const config = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, config.replace(/bare = false/, 'bare = false # regular worktree'))

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })

    writeFileSync(configPath, config.replace(/bare = false/, 'bare = false ; regular worktree'))

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })
  })

  it('rejects a regular repository admin directory when core.bare is quoted false', () => {
    const realRepo = path.join(tmpDir, 'admin-dir-quoted-false')
    mkdirSync(realRepo)
    git(realRepo, ['init', '--quiet'])
    const configPath = path.join(realRepo, '.git', 'config')
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(/bare = false/, String.raw`bare = \"false\"`)
    )

    withGitUnavailable(() => {
      expect(isGitRepo(path.join(realRepo, '.git'))).toBe(false)
    })
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

  it('keeps WSL UNC identity when git reports a Linux worktree root', () => {
    expect(
      normalizeGitRepoRootForInputPath(
        String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\packages\web`,
        '/home/alice/repo'
      )
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`)
  })

  it('preserves bare repository paths when no worktree root exists', () => {
    const bareRepo = path.join(tmpDir, 'bare.git')
    git(tmpDir, ['init', '--bare', '--quiet', bareRepo])

    expect(getGitRepoRoot(bareRepo)).toBe(bareRepo)
  })
})

/**
 * Run `fn` with `git` removed from PATH so the in-process git probe fails the
 * same way a transient spawn failure would, exercising the `.git`-marker
 * fallback path. PATH is restored afterward.
 */
function withGitUnavailable(fn: () => void): void {
  const originalPath = process.env.PATH
  // An empty PATH leaves no directory to resolve the bare `git` binary, so the
  // probe throws ENOENT — the indeterminate failure the fallback exists for.
  process.env.PATH = ''
  try {
    fn()
  } finally {
    // Why: restoring an originally-unset PATH via assignment would write the
    // string "undefined", corrupting PATH for later tests in this process.
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  }
}
