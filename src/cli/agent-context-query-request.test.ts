import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT_CONTEXT_SEARCH_LIMIT,
  MAX_AGENT_CONTEXT_QUERY_LENGTH,
  MAX_AGENT_CONTEXT_SEARCH_LIMIT,
  parseAgentContextRequest
} from './agent-context-query-request'

function flags(entries: [string, string | boolean][] = []): Map<string, string | boolean> {
  return new Map(entries)
}

describe('parseAgentContextRequest', () => {
  it('preserves the legacy unfiltered request', () => {
    expect(parseAgentContextRequest(flags(), false)).toEqual({
      query: null,
      compact: false
    })
  })

  it('builds normalized exact and prefix queries', () => {
    expect(parseAgentContextRequest(flags([['command', '  Worktree   Create ']]), true)).toEqual({
      query: { view: 'command', value: 'worktree create', detail: 'full' },
      compact: false
    })
    expect(
      parseAgentContextRequest(
        flags([
          ['prefix', ' Agent Hooks '],
          ['full', true]
        ]),
        true
      )
    ).toEqual({
      query: { view: 'prefix', value: 'agent hooks', detail: 'full' },
      compact: false
    })
  })

  it('uses bounded search defaults and accepts the maximum limit', () => {
    expect(parseAgentContextRequest(flags([['search', 'setup hooks']]), true).query).toEqual({
      view: 'search',
      value: 'setup hooks',
      detail: 'summary',
      limit: DEFAULT_AGENT_CONTEXT_SEARCH_LIMIT
    })
    expect(
      parseAgentContextRequest(
        flags([
          ['search', 'setup'],
          ['limit', String(MAX_AGENT_CONTEXT_SEARCH_LIMIT)]
        ]),
        true
      ).query
    ).toMatchObject({ limit: MAX_AGENT_CONTEXT_SEARCH_LIMIT })
  })

  it('accepts compact JSON for query and legacy responses', () => {
    expect(
      parseAgentContextRequest(
        flags([
          ['roots', true],
          ['compact', true]
        ]),
        true
      )
    ).toEqual({ query: { view: 'roots' }, compact: true })
    expect(parseAgentContextRequest(flags([['compact', true]]), true)).toEqual({
      query: null,
      compact: true
    })
  })

  it('rejects selector ambiguity and missing values', () => {
    expect(() =>
      parseAgentContextRequest(
        flags([
          ['roots', true],
          ['search', 'setup']
        ]),
        true
      )
    ).toThrow('Pass only one agent-context selector')
    expect(() => parseAgentContextRequest(flags([['command', true]]), true)).toThrow(
      'Flag --command requires a value.'
    )
    expect(() => parseAgentContextRequest(flags([['search', '  ']]), true)).toThrow(
      'Flag --search requires a value.'
    )
  })

  it('rejects flags outside their supported query modes', () => {
    expect(() => parseAgentContextRequest(flags([['limit', '2']]), true)).toThrow(
      '--limit requires --search.'
    )
    expect(() =>
      parseAgentContextRequest(
        flags([
          ['prefix', 'worktree'],
          ['limit', '2']
        ]),
        true
      )
    ).toThrow('--limit requires --search.')
    expect(() => parseAgentContextRequest(flags([['full', true]]), true)).toThrow(
      '--full requires --prefix or --search.'
    )
  })

  it('rejects invalid limits and boolean values', () => {
    for (const limit of ['0', '-1', '1.5', String(MAX_AGENT_CONTEXT_SEARCH_LIMIT + 1)]) {
      expect(() =>
        parseAgentContextRequest(
          flags([
            ['search', 'setup'],
            ['limit', limit]
          ]),
          true
        )
      ).toThrow(`--limit must be an integer from 1 to ${MAX_AGENT_CONTEXT_SEARCH_LIMIT}.`)
    }
    expect(() => parseAgentContextRequest(flags([['roots', 'yes']]), true)).toThrow(
      '--roots does not take a value.'
    )
  })

  it('requires JSON for compact output', () => {
    expect(() => parseAgentContextRequest(flags([['compact', true]]), false)).toThrow(
      '--compact requires --json.'
    )
  })

  it('bounds selector input before echoing it into a response', () => {
    expect(() =>
      parseAgentContextRequest(
        flags([['search', 'x'.repeat(MAX_AGENT_CONTEXT_QUERY_LENGTH + 1)]]),
        true
      )
    ).toThrow(`--search must be at most ${MAX_AGENT_CONTEXT_QUERY_LENGTH} characters.`)
  })
})
