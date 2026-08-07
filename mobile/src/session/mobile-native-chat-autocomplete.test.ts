import { describe, expect, it } from 'vitest'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSlashCommandSuggestions,
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

describe('rankSlashCommandSuggestions', () => {
  const commands = [
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'compact', description: 'Summarize and compact' },
    { name: 'mcp', description: 'List MCP tools' }
  ]

  it('shows the whole catalog for a bare slash', () => {
    expect(rankSlashCommandSuggestions(commands, '').map((c) => c.name)).toEqual([
      'clear',
      'compact',
      'mcp'
    ])
  })

  it('ranks prefix matches ahead of substring matches', () => {
    expect(rankSlashCommandSuggestions(commands, 'c').map((c) => c.name)).toEqual([
      'clear',
      'compact',
      'mcp'
    ])
    expect(rankSlashCommandSuggestions(commands, 'm').map((c) => c.name)).toEqual([
      'mcp',
      'compact'
    ])
  })

  it('is case-insensitive and drops non-matches', () => {
    expect(rankSlashCommandSuggestions(commands, 'CLE').map((c) => c.name)).toEqual(['clear'])
    expect(rankSlashCommandSuggestions(commands, 'zzz')).toEqual([])
  })
})
