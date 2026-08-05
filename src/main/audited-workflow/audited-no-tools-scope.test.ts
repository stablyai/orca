// Mediated retrieval: what the model may and may not ask Orca to read.
//
// Uses a REAL temp directory rather than a mocked filesystem, because the
// properties under test are filesystem properties — symlink targets, path
// resolution, containment. A mock would assert that the code matches the mock's
// idea of a filesystem, which is exactly the assumption that fails in
// production.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NO_TOOLS_LIMITS } from '../../shared/audited-audit-mode-types'
import { resolveRequestedPath, validateContextRequest } from './audited-no-tools-scope'

let root: string
let outside: string

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'orca-scope-'))
  root = join(base, 'worktree')
  outside = join(base, 'secrets')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'README.md'), '# readme\n')
  writeFileSync(join(root, '.env'), 'SECRET=hunter2\n')
  writeFileSync(join(root, 'deploy.pem'), 'PRIVATE KEY\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  writeFileSync(join(outside, 'credentials'), 'aws_secret=1\n')
  writeFileSync(join(root, 'huge.txt'), 'x'.repeat(NO_TOOLS_LIMITS.maxFileBytes + 1))
})

afterAll(() => {
  rmSync(join(root, '..'), { recursive: true, force: true })
})

describe('an allowed file resolves', () => {
  it('accepts a repository-relative path', () => {
    const result = resolveRequestedPath(root, 'src/index.ts')
    expect(result.ok).toBe(true)
    expect(result.ok && result.relativePath).toBe('src/index.ts')
  })

  it('normalizes backslashes so a Windows-shaped request still resolves', () => {
    const result = resolveRequestedPath(root, 'src\\index.ts')
    // The relative path is returned POSIX-separated regardless of input, so the
    // bundle heading reads the same on every platform.
    expect(result.ok && result.relativePath).toBe('src/index.ts')
  })
})

describe('paths outside the permitted scope are refused', () => {
  it.each([
    ['a POSIX absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\System32\\config\\SAM'],
    ['a UNC path', '\\\\server\\share\\file'],
    ['a leading-slash path', '/src/index.ts']
  ])('refuses %s', (_label, path) => {
    const result = resolveRequestedPath(root, path)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('not_relative')
  })

  it.each([
    ['a parent traversal', '../secrets/credentials'],
    ['an embedded traversal', 'src/../../secrets/credentials'],
    ['a backslash traversal', '..\\secrets\\credentials']
  ])('refuses %s', (_label, path) => {
    const result = resolveRequestedPath(root, path)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('traversal')
  })

  it.each([
    ['the git directory', '.git/config'],
    ['a dotenv file', '.env'],
    ['a private key by suffix', 'deploy.pem']
  ])('refuses %s even though it is inside the tree', (_label, path) => {
    const result = resolveRequestedPath(root, path)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('outside_scope')
  })

  it('refuses a symlink whose TARGET escapes the tree', (context) => {
    // The escape every textual check misses: the path is relative, has no
    // traversal, and resolves inside the worktree. Only comparing real paths
    // catches it.
    const link = join(root, 'innocent.txt')
    try {
      symlinkSync(join(outside, 'credentials'), link, 'file')
    } catch {
      // Unprivileged Windows without Developer Mode refuses symlink creation
      // (EPERM). SKIPPED EXPLICITLY rather than returning silently: a security
      // assertion that quietly no-ops reads as "passed" in CI, and on a Windows
      // dev machine this is the one arm that would never run. ctx.skip() makes
      // the gap visible in the report instead.
      context.skip()
      return
    }

    const result = resolveRequestedPath(root, 'innocent.txt')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('outside_scope')
  })

  it('refuses a path with an embedded NUL', () => {
    const result = resolveRequestedPath(root, 'safe.ts\0../../etc/passwd')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('malformed')
  })

  it('refuses a sibling directory sharing a name prefix', () => {
    // "/worktree-secrets" must not count as inside "/worktree". A startsWith
    // containment check would accept it.
    const sibling = `${root}-secrets`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'leak.txt'), 'secret\n')
    const result = resolveRequestedPath(root, '../worktree-secrets/leak.txt')
    expect(result.ok).toBe(false)
  })
})

describe('size and shape budgets', () => {
  it('refuses a file over the per-file cap', () => {
    const result = resolveRequestedPath(root, 'huge.txt')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('too_large')
  })

  it('refuses a directory', () => {
    const result = resolveRequestedPath(root, 'src')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('not_a_file')
  })

  it('refuses a file that does not exist', () => {
    const result = resolveRequestedPath(root, 'nope.ts')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection).toBe('not_a_file')
  })

  it.each([
    ['a non-array', { needFiles: 'a.ts' }],
    ['an empty list', []],
    ['a non-string entry', ['a.ts', 42]]
  ])('refuses %s', (_label, requested) => {
    expect(validateContextRequest(requested).ok).toBe(false)
  })

  it('refuses a request naming more files than the cap allows', () => {
    const tooMany = Array.from(
      { length: NO_TOOLS_LIMITS.maxRequestedFiles + 1 },
      (_unused, index) => `src/f${index}.ts`
    )
    expect(validateContextRequest(tooMany).ok).toBe(false)
  })

  it('accepts a request exactly at the cap', () => {
    const atCap = Array.from(
      { length: NO_TOOLS_LIMITS.maxRequestedFiles },
      (_unused, index) => `src/f${index}.ts`
    )
    expect(validateContextRequest(atCap).ok).toBe(true)
  })
})
