import { describe, expect, it } from 'vitest'
import { herdrAgentKind, herdrAgentName } from './herdr-agent-kind'

describe('herdrAgentKind', () => {
  it('maps overlapping Orca agents onto stock Herdr kinds', () => {
    expect(herdrAgentKind('claude')).toBe('claude')
    expect(herdrAgentKind('codex')).toBe('codex')
    expect(herdrAgentKind('grok')).toBe('grok')
  })

  it('leaves Orca-only agents on the command-write path', () => {
    expect(herdrAgentKind('claude-agent-teams')).toBeNull()
    expect(herdrAgentKind(undefined)).toBeNull()
  })
})

describe('herdrAgentName', () => {
  it('builds a stock-legal name from a leaf id', () => {
    const name = herdrAgentName('22222222-2222-4222-8222-222222222222')
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
    expect(name.startsWith('o')).toBe(true)
  })
})
