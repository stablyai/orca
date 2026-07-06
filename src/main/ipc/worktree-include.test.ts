import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveWorktreeIncludePaths, resolveWorktreeLinkedPaths } from './worktree-include'

// Why: these tests drive real git (unmocked gitExecFileAsync) because the whole
// value of the module is git's own semantics — `ls-files --others --ignored
// --directory --exclude-from` intersected with `check-ignore`. A mock would
// only re-assert our assumptions, not git's actual behavior (whole-directory
// collapse, negation precedence, the gitignored-only intersection), which is
// exactly where the interesting bugs live.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet'])
  // Why: explicit symbolic-ref instead of `git init --initial-branch` so the
  // initial branch is deterministic regardless of host git version / config.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.email', 'test@test.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

function write(dir: string, rel: string, content = 'x\n'): void {
  const full = path.join(dir, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** Stage the given repo-relative paths and commit them, making them tracked. */
function commitTracked(dir: string, rels: string[], opts: { force?: boolean } = {}): void {
  git(dir, ['add', ...(opts.force ? ['-f'] : []), ...rels])
  git(dir, ['commit', '--quiet', '-m', 'init'])
}

describe('resolveWorktreeIncludePaths', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-wtinc-test-'))
    initRepo(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns [] when no .worktreeinclude file exists', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'local.env')
    commitTracked(repo, ['.gitignore'])

    expect(await resolveWorktreeIncludePaths(repo)).toEqual([])
  })

  it('returns [] when .worktreeinclude is empty', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'local.env')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', '')

    expect(await resolveWorktreeIncludePaths(repo)).toEqual([])
  })

  it('expands globs to the untracked gitignored files that match', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'local.env')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', '*.env\n')

    expect(await resolveWorktreeIncludePaths(repo)).toEqual(['local.env'])
  })

  it('collapses a whole ignored directory to a single entry (no per-file blowup)', async () => {
    write(repo, '.gitignore', 'node_modules/\n')
    write(repo, 'node_modules/a')
    write(repo, 'node_modules/deep/b')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', 'node_modules\n')

    const result = await resolveWorktreeIncludePaths(repo)

    expect(result).toEqual(['node_modules/'])
    expect(result).not.toContain('node_modules/a')
    expect(result).not.toContain('node_modules/deep/b')
  })

  it('selects a single file inside an ignored dir without over-copying the dir', async () => {
    write(repo, '.gitignore', 'config/\n')
    write(repo, 'config/secrets.json')
    write(repo, 'config/public.json')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', 'config/secrets.json\n')

    const result = await resolveWorktreeIncludePaths(repo)

    expect(result).toEqual(['config/secrets.json'])
    expect(result).not.toContain('config/')
    expect(result).not.toContain('config/public.json')
  })

  it('excludes a matched path that is not gitignored (gitignored-only rule)', async () => {
    // notignored.txt is untracked and matches the include pattern, but no
    // .gitignore rule covers it — the check-ignore intersection must drop it.
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'notignored.txt')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', 'notignored.txt\n')

    const result = await resolveWorktreeIncludePaths(repo)

    expect(result).toEqual([])
    expect(result).not.toContain('notignored.txt')
  })

  it('never returns a tracked file even when it matches the include pattern', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'tracked.env', 'committed\n')
    write(repo, 'local.env')
    // tracked.env matches the *.env ignore shape, so force-add past .gitignore.
    commitTracked(repo, ['.gitignore', 'tracked.env'], { force: true })
    write(repo, '.worktreeinclude', '*.env\n')

    const result = await resolveWorktreeIncludePaths(repo)

    // Only the untracked match is returned; the tracked one is excluded.
    expect(result).toEqual(['local.env'])
    expect(result).not.toContain('tracked.env')
  })

  it('honors negation patterns (! re-excludes an earlier glob match)', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'local.env')
    write(repo, 'keep.env')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', '*.env\n!keep.env\n')

    const result = await resolveWorktreeIncludePaths(repo)

    expect(result).toEqual(['local.env'])
    expect(result).not.toContain('keep.env')
  })

  it('ignores comment and blank lines in .worktreeinclude', async () => {
    write(repo, '.gitignore', '*.env\n')
    write(repo, 'local.env')
    commitTracked(repo, ['.gitignore'])
    write(repo, '.worktreeinclude', '# a comment\n\n   \n*.env\n')

    expect(await resolveWorktreeIncludePaths(repo)).toEqual(['local.env'])
  })
})

describe('resolveWorktreeLinkedPaths', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-wtinc-test-'))
    initRepo(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('unions symlinkPaths first with the resolved include paths, deduped', async () => {
    write(repo, '.gitignore', '.env\nnode_modules/\n')
    write(repo, '.env')
    write(repo, 'node_modules/a')
    commitTracked(repo, ['.gitignore'])
    // Include resolves to ['.env', 'node_modules/']; '.env' overlaps a
    // configured symlinkPath, 'node_modules/' is distinct.
    write(repo, '.worktreeinclude', '.env\nnode_modules\n')

    const result = await resolveWorktreeLinkedPaths(repo, ['.env', 'user-only-link'])

    // symlinkPaths keep their order and lead; the overlapping '.env' is deduped,
    // and only the distinct include entry is appended.
    expect(result).toEqual(['.env', 'user-only-link', 'node_modules/'])
  })

  it('returns exactly the deduped symlinkPaths when no .worktreeinclude exists', async () => {
    write(repo, '.gitignore', '*.env\n')
    commitTracked(repo, ['.gitignore'])

    const result = await resolveWorktreeLinkedPaths(repo, ['.env', '.env', 'foo'])

    expect(result).toEqual(['.env', 'foo'])
  })
})
