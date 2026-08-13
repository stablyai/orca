import { describe, expect, it } from 'vitest'
import { ClientDefaultAgentSessionRules } from './agent-session-rules-rpc-schema'

function snapshot(content: string) {
  return {
    enabled: true,
    rules: [
      {
        id: 'client-rule',
        label: 'Client rule',
        content,
        enabled: true,
        source: 'custom' as const
      }
    ],
    seenBuiltinRuleIds: ['builtin-graphify']
  }
}

describe('client default agent session rules RPC schema', () => {
  it('preserves a bounded client-owned snapshot', () => {
    expect(ClientDefaultAgentSessionRules.parse(snapshot('Apply the client rule.'))).toEqual(
      snapshot('Apply the client rule.')
    )
  })

  it('rejects oversized snapshots before dispatch', () => {
    expect(() =>
      ClientDefaultAgentSessionRules.parse(snapshot('x'.repeat(256 * 1024 + 1)))
    ).toThrow('Agent session rule content is too large')
  })
})
