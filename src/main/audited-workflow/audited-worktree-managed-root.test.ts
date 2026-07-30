import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeAllowingMissing,
  deriveManagedRootLayout,
  isPathInside,
  isSafePathSegment,
  pathsEqualForHost,
  prepareManagedRoot
} from './audited-worktree-managed-root'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-mroot-'))
  roots.push(root)
  return canonicalizeAllowingMissing(root)
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true })
    } catch {
      // Leaked temp dirs are harmless and must not fail a test.
    }
  }
})

describe('isSafePathSegment', () => {
  it('accepts generated ids', () => {
    expect(isSafePathSegment('audited_0123456789abcdef')).toBe(true)
    expect(isSafePathSegment('a1b2-c3d4')).toBe(true)
  })

  it.each([
    ['..'],
    ['.'],
    [''],
    ['a/b'],
    ['a\\b'],
    ['C:'],
    ['con'],
    ['PRN'],
    ['com1'],
    ['lpt9'],
    ['trailing.'],
    ['with space']
  ])('rejects the unsafe segment %j', (segment) => {
    expect(isSafePathSegment(segment)).toBe(false)
  })
})

describe('isPathInside', () => {
  it('treats a path as inside itself', () => {
    expect(isPathInside('/a/b', '/a/b', 'linux')).toBe(true)
  })

  it('rejects traversal escapes', () => {
    expect(isPathInside('/a/b/../..', '/a/b', 'linux')).toBe(false)
    expect(isPathInside('/other', '/a/b', 'linux')).toBe(false)
  })

  it('is case-insensitive on win32 only', () => {
    expect(pathsEqualForHost('C:\\Repo', 'c:\\repo', 'win32')).toBe(true)
    expect(pathsEqualForHost('/Repo', '/repo', 'linux')).toBe(false)
  })

  it('ignores a trailing separator', () => {
    expect(pathsEqualForHost('/a/b/', '/a/b', 'linux')).toBe(true)
  })
})

describe('deriveManagedRootLayout containment', () => {
  it('refuses a workspace root configured INSIDE the source repository', () => {
    const root = tempRoot()
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath, { recursive: true })

    const result = deriveManagedRootLayout({
      workspaceRoot: join(repoPath, 'workspaces'),
      sourceRepoPath: repoPath,
      repoId: 'repo1',
      taskId: 'audited_1'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'managed_root_inside_source_repo' })
  })

  it('refuses a source repository nested inside the managed root', () => {
    const root = tempRoot()
    const workspaceRoot = join(root, 'ws')
    const repoPath = join(workspaceRoot, '.orca-audited', 'repo1', 'nested-repo')
    mkdirSync(repoPath, { recursive: true })

    const result = deriveManagedRootLayout({
      workspaceRoot,
      sourceRepoPath: repoPath,
      repoId: 'repo1',
      taskId: 'audited_1'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'source_repo_inside_managed_root' })
  })

  it('rejects an unsafe path segment before any filesystem work', () => {
    const root = tempRoot()
    const result = deriveManagedRootLayout({
      workspaceRoot: join(root, 'ws'),
      sourceRepoPath: join(root, 'repo'),
      repoId: '../escape',
      taskId: 'audited_1'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'managed_root_unavailable' })
  })

  it('accepts a sibling workspace root and nests by repo and task', () => {
    const root = tempRoot()
    const result = deriveManagedRootLayout({
      workspaceRoot: join(root, 'ws'),
      sourceRepoPath: join(root, 'repo'),
      repoId: 'repo1',
      taskId: 'audited_1'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    expect(result.layout.worktreePath.endsWith(join('.orca-audited', 'repo1', 'audited_1'))).toBe(
      true
    )
  })
})

describe('canonicalizeAllowingMissing', () => {
  it('resolves the nearest existing ancestor and re-appends the missing tail', () => {
    const root = tempRoot()
    const missing = join(root, 'a', 'b', 'c')

    const canonical = canonicalizeAllowingMissing(missing)

    expect(canonical.endsWith(join('a', 'b', 'c'))).toBe(true)
    expect(existsSync(missing)).toBe(false)
  })
})

describe('prepareManagedRoot', () => {
  it('creates missing ancestors and revalidates afterwards', () => {
    const root = tempRoot()
    const result = prepareManagedRoot({
      workspaceRoot: join(root, 'ws'),
      sourceRepoPath: join(root, 'repo'),
      repoId: 'repo1',
      taskId: 'audited_1'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    expect(existsSync(result.layout.managedRoot)).toBe(true)
    // The worktree leaf itself is created by git, not by mkdir.
    expect(existsSync(result.layout.worktreePath)).toBe(false)
  })

  it('detects a symlinked workspace root that escapes into the source repo', () => {
    const root = tempRoot()
    const repoPath = join(root, 'repo')
    mkdirSync(join(repoPath, 'inside'), { recursive: true })
    const linkPath = join(root, 'ws-link')
    try {
      symlinkSync(join(repoPath, 'inside'), linkPath, 'junction')
    } catch {
      return // Platform forbids link creation (unprivileged Windows); nothing to assert.
    }

    const result = prepareManagedRoot({
      workspaceRoot: linkPath,
      sourceRepoPath: repoPath,
      repoId: 'repo1',
      taskId: 'audited_1'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'managed_root_inside_source_repo' })
  })
})
