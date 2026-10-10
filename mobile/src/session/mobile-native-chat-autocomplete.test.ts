import { describe, expect, it, vi } from 'vitest'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'

describe('detectAutocompleteTrigger', () => {
  it('detects a slash command only at the start', () => {
    expect(detectAutocompleteTrigger('/rev', 4)).toEqual({
      kind: 'slash',
      query: 'rev',
      start: 0,
      end: 4
    })
    expect(detectAutocompleteTrigger('hi /rev', 7)).toBeNull()
  })

  it('detects an @ mention after whitespace or at start', () => {
    expect(detectAutocompleteTrigger('@src', 4)).toMatchObject({ kind: 'file', query: 'src' })
    expect(detectAutocompleteTrigger('look at @comp', 13)).toMatchObject({
      kind: 'file',
      query: 'comp'
    })
  })

  it('does not trigger @ mid-word (email-like)', () => {
    expect(detectAutocompleteTrigger('me@host', 7)).toBeNull()
  })

  it('closes the token once a space is typed', () => {
    expect(detectAutocompleteTrigger('@src ', 5)).toBeNull()
  })

  it('returns empty query right after the trigger char', () => {
    expect(detectAutocompleteTrigger('@', 1)).toMatchObject({ kind: 'file', query: '' })
  })
})

describe('applyAutocomplete', () => {
  it('replaces the trigger span and leaves a trailing space + cursor', () => {
    const trigger = detectAutocompleteTrigger('look at @comp', 13)!
    const { text, cursor } = applyAutocomplete('look at @comp', trigger, '@src/App.tsx')
    expect(text).toBe('look at @src/App.tsx ')
    expect(cursor).toBe(text.length)
  })
})

describe('rankSuggestions', () => {
  it('prefers prefix matches on the basename', () => {
    const out = rankSuggestions(['src/app/Main.tsx', 'src/AppBar.tsx', 'lib/zapp.ts'], 'app')
    expect(out[0]).toBe('src/AppBar.tsx')
    expect(out).toContain('lib/zapp.ts')
  })

  it('returns the head of the list for an empty query', () => {
    expect(rankSuggestions(['a', 'b', 'c'], '', 2)).toEqual(['a', 'b'])
  })
})

describe.each([{ name: 'file', rank: rankSuggestions }])('$name suggestion bounds', ({ rank }) => {
  it('keeps later prefixes ahead of the earliest substring matches', () => {
    const candidates = ['team-review', 'team-review', 'pre-review', 'review-a', 'REVIEW-b']
    expect(rank(candidates, 'REVIEW', 4)).toEqual([
      'review-a',
      'REVIEW-b',
      'team-review',
      'team-review'
    ])
  })

  it('stops substring matching once enough fallback suggestions are retained', () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) => `team-review-${index}`)
    candidates.push('review-last', 'review-final')
    const includes = String.prototype.includes
    let substringChecks = 0
    const spy = vi.spyOn(String.prototype, 'includes').mockImplementation(function (
      this: string,
      search: string,
      position?: number
    ) {
      substringChecks += 1
      return includes.call(this, search, position)
    })
    let result: string[]
    try {
      result = rank(candidates, 'review', 8)
    } finally {
      spy.mockRestore()
    }
    expect(result).toEqual(['review-last', 'review-final', ...candidates.slice(0, 6)])
    expect(substringChecks).toBeLessThanOrEqual(8)
  })

  it.each([0, -0, -1, -0.5, -Infinity, Number.NaN])(
    'preserves empty results for limit %s',
    (limit) => {
      expect(rank(['team-review', 'review-a', 'review-b'], 'review', limit)).toEqual([])
    }
  )

  it.each([0.5, 1.5, 2.5, Infinity])('preserves slice truncation for limit %s', (limit) => {
    const candidates = ['team-review', 'pre-review', 'review-a', 'review-b']
    expect(rank(candidates, 'review', limit)).toEqual(
      ['review-a', 'review-b', 'team-review', 'pre-review'].slice(0, limit)
    )
    expect(rank(candidates, '', limit)).toEqual(candidates.slice(0, limit))
  })
})
