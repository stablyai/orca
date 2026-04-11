/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { GitWorktreeInfo } from '../../shared/types'

const { gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: vi.fn((output: string) => output)
}))

import {
  resolveGitCommonDir,
  nestedExcludePattern,
  addNestedWorktreeExclude,
  removeNestedWorktreeExclude,
  ensureNestedWorktreeExcludes,
  healMissingDotGitFiles
} from './worktree'

// ─── resolveGitCommonDir ────────────────────────────────────────────

describe('resolveGitCommonDir', () => {
  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
  })

  it('returns the path directly when git returns a posix absolute path', () => {
    gitExecFileSyncMock.mockReturnValueOnce('/repo/.git\n')
    expect(resolveGitCommonDir('/repo')).toBe('/repo/.git')
  })

  it('returns the path directly when git returns a Windows absolute path', () => {
    gitExecFileSyncMock.mockReturnValueOnce('C:\\repo\\.git\n')
    expect(resolveGitCommonDir('C:\\repo')).toBe('C:\\repo\\.git')
  })

  it('joins relative path with repoPath', () => {
    gitExecFileSyncMock.mockReturnValueOnce('.git\n')
    expect(resolveGitCommonDir('/repo')).toBe(join('/repo', '.git'))
  })

  it('returns null when git command fails', () => {
    gitExecFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a git repo')
    })
    expect(resolveGitCommonDir('/not-a-repo')).toBeNull()
  })
})

// ─── nestedExcludePattern ───────────────────────────────────────────

describe('nestedExcludePattern', () => {
  it('returns repo-relative pattern for nested worktree', () => {
    expect(nestedExcludePattern('/repo', '/repo/my-worktree')).toBe('/my-worktree')
  })

  it('returns pattern with nested path', () => {
    expect(nestedExcludePattern('/repo', '/repo/worktrees/feature-x')).toBe('/worktrees/feature-x')
  })

  it('returns null for worktree outside repo', () => {
    expect(nestedExcludePattern('/repo', '/other/worktree')).toBeNull()
  })

  it('returns null when worktree equals repo', () => {
    expect(nestedExcludePattern('/repo', '/repo')).toBeNull()
  })

  it('returns null for parent directory', () => {
    expect(nestedExcludePattern('/repo/sub', '/repo')).toBeNull()
  })

  it('handles Windows paths with forward-slash pattern', () => {
    expect(nestedExcludePattern('C:\\repo', 'C:\\repo\\my-worktree')).toBe('/my-worktree')
  })

  it('returns null for Windows paths outside repo', () => {
    expect(nestedExcludePattern('C:\\repo', 'D:\\other\\worktree')).toBeNull()
  })
})

// ─── addNestedWorktreeExclude ───────────────────────────────────────

describe('addNestedWorktreeExclude', () => {
  let tempDir: string
  let repoDir: string
  let infoDir: string
  let excludePath: string

  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    repoDir = join(tempDir, 'repo')
    infoDir = join(repoDir, '.git', 'info')
    excludePath = join(infoDir, 'exclude')
    mkdirSync(infoDir, { recursive: true })
    // Mock git to return the .git dir
    gitExecFileSyncMock.mockReturnValue('.git\n')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('adds marker and pattern to empty exclude file', () => {
    writeFileSync(excludePath, '')
    addNestedWorktreeExclude(repoDir, join(repoDir, 'my-wt'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toContain('# orca-managed nested worktrees')
    expect(content).toContain('/my-wt')
  })

  it('adds pattern after existing marker without duplicating marker', () => {
    writeFileSync(excludePath, '# orca-managed nested worktrees\n/first-wt\n')
    addNestedWorktreeExclude(repoDir, join(repoDir, 'second-wt'))
    const content = readFileSync(excludePath, 'utf-8')
    const markers = content.split('# orca-managed nested worktrees').length - 1
    expect(markers).toBe(1)
    expect(content).toContain('/second-wt')
  })

  it('skips adding when pattern already exists', () => {
    const original = '# orca-managed nested worktrees\n/my-wt\n'
    writeFileSync(excludePath, original)
    addNestedWorktreeExclude(repoDir, join(repoDir, 'my-wt'))
    expect(readFileSync(excludePath, 'utf-8')).toBe(original)
  })

  it('creates info directory if missing', () => {
    rmSync(infoDir, { recursive: true, force: true })
    addNestedWorktreeExclude(repoDir, join(repoDir, 'my-wt'))
    expect(existsSync(excludePath)).toBe(true)
  })

  it('does nothing for non-nested worktree', () => {
    writeFileSync(excludePath, '')
    addNestedWorktreeExclude(repoDir, '/other/path/wt')
    expect(readFileSync(excludePath, 'utf-8')).toBe('')
  })

  it('preserves existing user content', () => {
    writeFileSync(excludePath, '# user rules\n*.log\n')
    addNestedWorktreeExclude(repoDir, join(repoDir, 'my-wt'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toContain('# user rules')
    expect(content).toContain('*.log')
    expect(content).toContain('/my-wt')
  })

  it('preserves CRLF line endings when appending', () => {
    writeFileSync(excludePath, '# user rules\r\n*.log\r\n')
    addNestedWorktreeExclude(repoDir, join(repoDir, 'my-wt'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toContain('\r\n')
    expect(content).toMatch(/# orca-managed nested worktrees\r\n/)
    expect(content).toMatch(/\/my-wt\r\n/)
  })
})

// ─── removeNestedWorktreeExclude ────────────────────────────────────

describe('removeNestedWorktreeExclude', () => {
  let tempDir: string
  let repoDir: string
  let excludePath: string

  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    repoDir = join(tempDir, 'repo')
    const infoDir = join(repoDir, '.git', 'info')
    excludePath = join(infoDir, 'exclude')
    mkdirSync(infoDir, { recursive: true })
    gitExecFileSyncMock.mockReturnValue('.git\n')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('removes the pattern from the Orca block', () => {
    writeFileSync(excludePath, '# orca-managed nested worktrees\n/wt-a\n/wt-b\n')
    removeNestedWorktreeExclude(repoDir, join(repoDir, 'wt-a'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).not.toContain('/wt-a')
    expect(content).toContain('/wt-b')
  })

  it('cleans up the marker when last pattern is removed', () => {
    writeFileSync(excludePath, 'user-line\n# orca-managed nested worktrees\n/only-wt\n')
    removeNestedWorktreeExclude(repoDir, join(repoDir, 'only-wt'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).not.toContain('# orca-managed nested worktrees')
    expect(content).not.toContain('/only-wt')
    expect(content).toContain('user-line')
  })

  it('does not remove user-authored lines matching the pattern outside the Orca block', () => {
    writeFileSync(excludePath, '/wt-a\n# orca-managed nested worktrees\n/wt-a\n')
    removeNestedWorktreeExclude(repoDir, join(repoDir, 'wt-a'))
    const content = readFileSync(excludePath, 'utf-8')
    // The user-authored line before the marker should survive
    const lines = content.split('\n')
    expect(lines[0]).toBe('/wt-a')
  })

  it('preserves CRLF line endings', () => {
    writeFileSync(excludePath, '# orca-managed nested worktrees\r\n/wt-a\r\n/wt-b\r\n')
    removeNestedWorktreeExclude(repoDir, join(repoDir, 'wt-a'))
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toContain('\r\n')
    expect(content).not.toContain('/wt-a')
  })

  it('does nothing when exclude file does not exist', () => {
    rmSync(excludePath, { force: true })
    // Should not throw
    removeNestedWorktreeExclude(repoDir, join(repoDir, 'wt-a'))
  })

  it('does nothing for non-nested worktree path', () => {
    const original = '# orca-managed nested worktrees\n/wt-a\n'
    writeFileSync(excludePath, original)
    removeNestedWorktreeExclude(repoDir, '/other/path')
    expect(readFileSync(excludePath, 'utf-8')).toBe(original)
  })
})

// ─── ensureNestedWorktreeExcludes ───────────────────────────────────

describe('ensureNestedWorktreeExcludes', () => {
  let tempDir: string
  let repoDir: string
  let excludePath: string

  function makeWorktree(path: string, overrides?: Partial<GitWorktreeInfo>): GitWorktreeInfo {
    return {
      path,
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: false,
      isPrunable: false,
      ...overrides
    }
  }

  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    repoDir = join(tempDir, 'repo')
    const infoDir = join(repoDir, '.git', 'info')
    excludePath = join(infoDir, 'exclude')
    mkdirSync(infoDir, { recursive: true })
    gitExecFileSyncMock.mockReturnValue('.git\n')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('adds missing patterns for nested worktrees', () => {
    writeFileSync(excludePath, '')
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(repoDir, 'wt-a')),
      makeWorktree(join(repoDir, 'wt-b'))
    ]
    ensureNestedWorktreeExcludes(repoDir, worktrees)
    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toContain('/wt-a')
    expect(content).toContain('/wt-b')
    expect(content).toContain('# orca-managed nested worktrees')
  })

  it('skips worktrees that already have entries', () => {
    writeFileSync(excludePath, '# orca-managed nested worktrees\n/wt-a\n')
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(repoDir, 'wt-a')),
      makeWorktree(join(repoDir, 'wt-b'))
    ]
    ensureNestedWorktreeExcludes(repoDir, worktrees)
    const content = readFileSync(excludePath, 'utf-8')
    // wt-a should appear exactly once
    const matches = content.match(/\/wt-a/g)
    expect(matches).toHaveLength(1)
    expect(content).toContain('/wt-b')
  })

  it('skips main and bare worktrees', () => {
    writeFileSync(excludePath, '')
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(repoDir, 'bare-wt'), { isBare: true })
    ]
    ensureNestedWorktreeExcludes(repoDir, worktrees)
    // File should remain empty (no patterns to add)
    expect(readFileSync(excludePath, 'utf-8')).toBe('')
  })

  it('skips non-nested worktrees', () => {
    writeFileSync(excludePath, '')
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree('/other/place/wt')
    ]
    ensureNestedWorktreeExcludes(repoDir, worktrees)
    expect(readFileSync(excludePath, 'utf-8')).toBe('')
  })

  it('preserves CRLF line endings when appending', () => {
    writeFileSync(excludePath, '# existing\r\n*.log\r\n')
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(repoDir, 'wt-a'))
    ]
    ensureNestedWorktreeExcludes(repoDir, worktrees)
    const content = readFileSync(excludePath, 'utf-8')
    // Should use CRLF for the new block
    expect(content).toMatch(/# orca-managed nested worktrees\r\n/)
    expect(content).toMatch(/\/wt-a\r\n/)
  })
})

// ─── healMissingDotGitFiles ─────────────────────────────────────────

describe('healMissingDotGitFiles', () => {
  let tempDir: string
  let repoDir: string
  let worktreesAdminDir: string

  function makeWorktree(path: string, overrides?: Partial<GitWorktreeInfo>): GitWorktreeInfo {
    return {
      path,
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: false,
      isPrunable: false,
      ...overrides
    }
  }

  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    repoDir = join(tempDir, 'repo')
    worktreesAdminDir = join(repoDir, '.git', 'worktrees')
    mkdirSync(worktreesAdminDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('recreates a missing .git file for a linked worktree', () => {
    const wtPath = join(tempDir, 'wt-a')
    mkdirSync(wtPath, { recursive: true })
    // Create admin entry pointing to this worktree
    const adminEntry = join(worktreesAdminDir, 'wt-a')
    mkdirSync(adminEntry, { recursive: true })
    writeFileSync(join(adminEntry, 'gitdir'), `${wtPath}/.git\n`)

    gitExecFileSyncMock.mockReturnValueOnce(`${join(repoDir, '.git')}\n`)

    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(wtPath)
    ]

    healMissingDotGitFiles(repoDir, worktrees)

    const dotGitPath = join(wtPath, '.git')
    expect(existsSync(dotGitPath)).toBe(true)
    const content = readFileSync(dotGitPath, 'utf-8')
    expect(content).toContain('gitdir: ')
    expect(content).toContain(adminEntry)
  })

  it('does not overwrite an existing .git file', () => {
    const wtPath = join(tempDir, 'wt-b')
    mkdirSync(wtPath, { recursive: true })
    const dotGitPath = join(wtPath, '.git')
    writeFileSync(dotGitPath, 'existing content')

    const adminEntry = join(worktreesAdminDir, 'wt-b')
    mkdirSync(adminEntry, { recursive: true })
    writeFileSync(join(adminEntry, 'gitdir'), `${wtPath}/.git\n`)

    gitExecFileSyncMock.mockReturnValueOnce(`${join(repoDir, '.git')}\n`)

    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(wtPath)
    ]

    healMissingDotGitFiles(repoDir, worktrees)
    expect(readFileSync(dotGitPath, 'utf-8')).toBe('existing content')
  })

  it('skips worktrees whose directory no longer exists', () => {
    gitExecFileSyncMock.mockReturnValueOnce(`${join(repoDir, '.git')}\n`)
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(tempDir, 'nonexistent'))
    ]
    // Should not throw
    healMissingDotGitFiles(repoDir, worktrees)
  })

  it('skips main and bare worktrees', () => {
    gitExecFileSyncMock.mockReturnValueOnce(`${join(repoDir, '.git')}\n`)
    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(join(tempDir, 'bare'), { isBare: true })
    ]
    // git command should not be called since all worktrees are skipped
    healMissingDotGitFiles(repoDir, worktrees)
    expect(gitExecFileSyncMock).not.toHaveBeenCalled()
  })

  it('handles git common dir resolution failure gracefully', () => {
    const wtPath = join(tempDir, 'wt-fail')
    mkdirSync(wtPath, { recursive: true })

    gitExecFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a git repo')
    })

    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(wtPath)
    ]
    // Should not throw
    healMissingDotGitFiles(repoDir, worktrees)
    expect(existsSync(join(wtPath, '.git'))).toBe(false)
  })

  it('caches common dir resolution across multiple worktrees', () => {
    const wt1 = join(tempDir, 'wt-1')
    const wt2 = join(tempDir, 'wt-2')
    mkdirSync(wt1, { recursive: true })
    mkdirSync(wt2, { recursive: true })

    // Only need to resolve once
    gitExecFileSyncMock.mockReturnValueOnce(`${join(repoDir, '.git')}\n`)

    const worktrees: GitWorktreeInfo[] = [
      makeWorktree(repoDir, { isMainWorktree: true }),
      makeWorktree(wt1),
      makeWorktree(wt2)
    ]

    healMissingDotGitFiles(repoDir, worktrees)
    // git rev-parse should have been called only once
    expect(gitExecFileSyncMock).toHaveBeenCalledTimes(1)
  })
})
