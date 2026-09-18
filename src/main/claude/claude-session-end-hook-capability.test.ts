import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_END_CAPABILITY_FLOOR,
  claudeVersionSupportsSessionEnd,
  parseClaudeCliVersion
} from './claude-session-end-hook-capability'

describe('Claude SessionEnd hook version capability', () => {
  it('records 2.1.261 as the measured floor', () => {
    expect(CLAUDE_SESSION_END_CAPABILITY_FLOOR).toBe('2.1.261')
  })

  it('extracts Claude Code version output', () => {
    expect(parseClaudeCliVersion('2.1.261 (Claude Code)')).toBe('2.1.261')
  })

  it.each([
    ['2.1.260', false],
    ['2.1.261', true],
    ['2.2.0', true],
    ['unknown', false],
    [undefined, false]
  ])('classifies %s as SessionEnd-capable: %s', (version, expected) => {
    expect(claudeVersionSupportsSessionEnd(version)).toBe(expected)
  })
})
