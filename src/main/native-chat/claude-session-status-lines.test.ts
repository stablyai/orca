import { describe, expect, it } from 'vitest'
import {
  applyClaudeSessionStatusLine,
  emptyClaudeSessionStatusFacts
} from './claude-session-status-lines'

const assistant = (
  usage: Record<string, number>,
  model = 'claude-opus-5-5',
  extra: Record<string, unknown> = {}
): string => JSON.stringify({ type: 'assistant', message: { model, usage }, ...extra })

const usage = (cacheRead: number) => ({
  input_tokens: 10,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: cacheRead,
  output_tokens: 500
})

const apiRequest = (effort: string, querySource = 'repl_main_thread'): string =>
  JSON.stringify({ type: 'api-request', querySource, params: { output_config: { effort } } })

const compactBoundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' })

function factsFrom(...lines: string[]) {
  const facts = emptyClaudeSessionStatusFacts()
  for (const line of lines) {
    applyClaudeSessionStatusLine(facts, line)
  }
  return facts
}

describe('applyClaudeSessionStatusLine', () => {
  it('takes model and context from the newest main-thread reply', () => {
    expect(factsFrom(assistant(usage(5)), assistant(usage(170000)))).toEqual({
      model: 'claude-opus-5-5',
      effort: null,
      usedTokens: 170030,
      compactions: 0
    })
  })

  it('ignores subagent replies', () => {
    const facts = factsFrom(
      assistant(usage(1000)),
      assistant(usage(999000), 'claude-haiku-5-5', { isSidechain: true })
    )
    expect(facts).toMatchObject({ model: 'claude-opus-5-5', usedTokens: 1030 })
  })

  it('ignores synthetic replies', () => {
    const zero = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0
    }
    const facts = factsFrom(assistant(usage(1000)), assistant(zero, '<synthetic>'))
    expect(facts).toMatchObject({ model: 'claude-opus-5-5', usedTokens: 1030 })
  })

  it('reads effort from main-thread requests only', () => {
    expect(factsFrom(apiRequest('high')).effort).toBe('high')
    expect(factsFrom(apiRequest('high'), apiRequest('low', 'agent:custom')).effort).toBe('high')
  })

  it('counts compactions and forgets the measured context until the next reply', () => {
    const compacted = factsFrom(assistant(usage(1000)), compactBoundary)
    expect(compacted).toMatchObject({ compactions: 1, usedTokens: null })
    applyClaudeSessionStatusLine(compacted, assistant(usage(2000)))
    expect(compacted).toMatchObject({ compactions: 1, usedTokens: 2030 })
  })

  it('does not count a subagent compaction', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      isSidechain: true
    })
    expect(factsFrom(assistant(usage(1000)), line)).toMatchObject({
      compactions: 0,
      usedTokens: 1030
    })
  })

  it('survives broken JSON and unknown rows', () => {
    const facts = factsFrom(
      assistant(usage(1000)),
      '{"type":"assistant", broken',
      '{"type":"assistant"}',
      '{"type":"api-request"}',
      'null'
    )
    expect(facts).toEqual({
      model: 'claude-opus-5-5',
      effort: null,
      usedTokens: 1030,
      compactions: 0
    })
  })
})
