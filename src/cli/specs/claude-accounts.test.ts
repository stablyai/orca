import { describe, expect, it } from 'vitest'
import { CLAUDE_ACCOUNTS_COMMAND_SPECS } from './claude-accounts'

describe('CLAUDE_ACCOUNTS_COMMAND_SPECS', () => {
  it('declares add/list/select/remove paths', () => {
    const paths = CLAUDE_ACCOUNTS_COMMAND_SPECS.map((s) => s.path.join(' '))
    expect(paths).toEqual(
      expect.arrayContaining([
        'claude-accounts add',
        'claude-accounts list',
        'claude-accounts select',
        'claude-accounts remove'
      ])
    )
  })

  it('claude-accounts add allows --provider, --label, per-provider flags, --validate', () => {
    const spec = CLAUDE_ACCOUNTS_COMMAND_SPECS.find(
      (s) => s.path.join(' ') === 'claude-accounts add'
    )!
    expect(spec.allowedFlags).toEqual(
      expect.arrayContaining([
        'provider',
        'label',
        'key-env',
        'token-env',
        'preset',
        'base-url',
        'resource',
        'use-entra-id',
        'region',
        'project-id',
        'validate'
      ])
    )
  })

  it('claude-accounts remove takes --account-id positionally or as flag', () => {
    const spec = CLAUDE_ACCOUNTS_COMMAND_SPECS.find(
      (s) => s.path.join(' ') === 'claude-accounts remove'
    )!
    expect(spec.positionalArgs).toEqual(['account-id'])
    expect(spec.allowedFlags).toEqual(expect.arrayContaining(['account-id']))
  })
})
