import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertObserverBearerOutputPath, outsideObserverSource } from './observer-credential-path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('owner-local observer credential path guard', () => {
  it('rejects bearer output at the fresh ledger or issue/revoke lock path', () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-observer-path-'))
    dirs.push(base)
    expect(() =>
      assertObserverBearerOutputPath(base, join(base, 'observer-credentials.v1.json'))
    ).toThrow('collides with observer credential store')
    expect(() =>
      assertObserverBearerOutputPath(base, join(base, 'observer-credentials.v1.json.lock'))
    ).toThrow('collides with observer credential store')
    expect(() => assertObserverBearerOutputPath(base, join(base, 'bearer.txt'))).not.toThrow()
  })
  it('rejects ordinary, dot-dot-prefixed, and symlinked paths inside the checkout', () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-observer-path-'))
    dirs.push(base)
    const repo = join(base, 'repo')
    mkdirSync(join(repo, '..review-output'), { recursive: true })
    expect(() => outsideObserverSource(repo, join(repo, 'plain.txt'))).toThrow(
      'outside the source checkout'
    )
    expect(() => outsideObserverSource(repo, join(repo, '..review-output', 'bearer.txt'))).toThrow(
      'outside the source checkout'
    )
    const alias = join(base, 'alias')
    symlinkSync(repo, alias, 'dir')
    expect(() => outsideObserverSource(repo, join(alias, '..review-output', 'bearer.txt'))).toThrow(
      'outside the source checkout'
    )
  })

  it('accepts a real sibling and refuses non-absolute or unresolved parents', () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-observer-path-'))
    dirs.push(base)
    const repo = join(base, 'repo')
    const sibling = join(base, '..review-output')
    mkdirSync(repo)
    mkdirSync(sibling)
    expect(outsideObserverSource(repo, join(sibling, 'bearer.txt'))).toBe(
      join(sibling, 'bearer.txt')
    )
    expect(() => outsideObserverSource(repo, 'relative.txt')).toThrow('absolute path')
    expect(() => outsideObserverSource(repo, join(base, 'missing', 'bearer.txt'))).toThrow()
  })
})
