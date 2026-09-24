import { describe, expect, it } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import { hasWorktreeTagFlags, resolveWorktreeTagFlags } from './worktree-tag-flags'

function flags(entries: Record<string, string | string[]>): Map<string, string | boolean> {
  return new Map(
    Object.entries(entries).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(REPEATED_FLAG_SEPARATOR) : value
    ])
  )
}

describe('resolveWorktreeTagFlags', () => {
  it('adds to and removes from the current tags, matching case-insensitively', () => {
    expect(
      resolveWorktreeTagFlags(flags({ tag: ['api', 'BILLING'], untag: 'Old' }), ['billing', 'old'])
    ).toEqual(['billing', 'api'])
  })

  it('replaces the set with a comma list', () => {
    expect(resolveWorktreeTagFlags(flags({ tags: ' web , api ,' }), ['billing'])).toEqual([
      'web',
      'api'
    ])
  })

  it('clears with null or an empty value', () => {
    expect(resolveWorktreeTagFlags(flags({ tags: 'null' }), ['billing'])).toEqual([])
    expect(resolveWorktreeTagFlags(flags({ tags: '' }), ['billing'])).toEqual([])
  })

  it('applies --tag and --untag after a --tags replacement', () => {
    expect(
      resolveWorktreeTagFlags(flags({ tags: 'a,b', tag: 'c', untag: 'a' }), ['ignored'])
    ).toEqual(['b', 'c'])
  })
})

describe('hasWorktreeTagFlags', () => {
  it('detects any tag flag', () => {
    expect(hasWorktreeTagFlags(flags({ comment: 'x' }))).toBe(false)
    expect(hasWorktreeTagFlags(flags({ untag: 'x' }))).toBe(true)
  })
})
