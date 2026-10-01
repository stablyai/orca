import { describe, expect, it } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from './args'
import { hasWorktreeTagFlags, parseWorktreeTagFlags } from './worktree-tag-flags'

function flags(entries: Record<string, string | string[]>): Map<string, string | boolean> {
  return new Map(
    Object.entries(entries).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(REPEATED_FLAG_SEPARATOR) : value
    ])
  )
}

describe('parseWorktreeTagFlags', () => {
  it('sends repeated --tag and --untag as host-side edits, not a replacement', () => {
    expect(parseWorktreeTagFlags(flags({ tag: ['api', 'API'], untag: 'Old' }))).toEqual({
      addTags: ['api'],
      removeTags: ['Old']
    })
  })

  it('replaces the set with a comma list', () => {
    expect(parseWorktreeTagFlags(flags({ tags: ' web , api ,' }))).toEqual({
      tags: ['web', 'api']
    })
  })

  it('clears with null or an empty value', () => {
    expect(parseWorktreeTagFlags(flags({ tags: 'null' }))).toEqual({ tags: [] })
    expect(parseWorktreeTagFlags(flags({ tags: '' }))).toEqual({ tags: [] })
  })

  it('combines a replacement with edits for the host to apply in order', () => {
    expect(parseWorktreeTagFlags(flags({ tags: 'a,b', tag: 'c', untag: 'a' }))).toEqual({
      tags: ['a', 'b'],
      addTags: ['c'],
      removeTags: ['a']
    })
  })
})

describe('hasWorktreeTagFlags', () => {
  it('detects any tag flag', () => {
    expect(hasWorktreeTagFlags(flags({ comment: 'x' }))).toBe(false)
    expect(hasWorktreeTagFlags(flags({ untag: 'x' }))).toBe(true)
  })
})
