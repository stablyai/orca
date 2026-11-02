import { describe, expect, it } from 'vitest'

import { ACCOUNT_COMMAND_SPECS } from './account'
import {
  findCommandSpec,
  normalizeCommandPositionals,
  parseArgs,
  specPaths,
  validateCommandAndFlags
} from '../args'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { formatCommandHelp } from '../help'
import { suggestCommands, unknownCommandData } from '../command-suggestion'

function spec(path: string): (typeof ACCOUNT_COMMAND_SPECS)[number] {
  const found = ACCOUNT_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing account spec: ${path}`)
  }
  return found
}

describe('account command specs', () => {
  it.each([
    ['rm', 'opencode'],
    ['remove', 'opencode'],
    ['rm', 'devin'],
    ['remove', 'devin']
  ])('routes account %s for %s through the canonical removal command', (verb, provider) => {
    const paths = ACCOUNT_COMMAND_SPECS.flatMap(specPaths)
    const parsed = normalizeCommandPositionals(
      ACCOUNT_COMMAND_SPECS,
      parseArgs(
        ['account', verb, '--agent', provider, '--account', 'profile-1', '--json'],
        paths,
        ACCOUNT_COMMAND_SPECS
      )
    )

    expect(parsed.commandPath).toEqual(['account', 'rm'])
    expect(parsed.flags.get('agent')).toBe(provider)
    expect(parsed.flags.get('account')).toBe('profile-1')
    expect(parsed.flags.get('json')).toBe(true)
    expect(() => validateCommandAndFlags(ACCOUNT_COMMAND_SPECS, parsed)).not.toThrow()
    expect(HANDLER_COMMAND_KEYS.has(parsed.commandPath.join(' '))).toBe(true)
  })

  it('shows canonical removal help for the existing remove alias', () => {
    const canonical = spec('account rm')

    expect(findCommandSpec(ACCOUNT_COMMAND_SPECS, ['account', 'remove'])).toBe(canonical)
    expect(formatCommandHelp(canonical)).toContain('orca account rm --agent opencode|devin')
    expect(HANDLER_COMMAND_KEYS.has('account remove')).toBe(false)
  })

  it.each(['move', 'go'])(
    'suggestion safety keeps benign account %s mistakes out of profile deletion',
    (verb) => {
      const path = ['account', verb]
      expect(suggestCommands(ACCOUNT_COMMAND_SPECS, path)).not.toContain('account rm')
      expect(suggestCommands(ACCOUNT_COMMAND_SPECS, path)).not.toContain('account remove')
      const data = unknownCommandData(ACCOUNT_COMMAND_SPECS, path)
      expect(data.nextSteps.join(' ')).not.toContain('orca account rm')
      expect(data.nextSteps.join(' ')).not.toContain('orca account remove')
    }
  )

  it('suggestion safety still recovers intended profile removal near-misses', () => {
    const data = unknownCommandData(ACCOUNT_COMMAND_SPECS, ['account', 'remov'])
    expect(data.suggestions).toContain('account rm')
    expect(data.suggestions).toContain('account remove')
    expect(data.nextSteps.join(' ')).toContain('orca account rm')
  })

  it('suggestion safety preserves non-destructive account list recovery', () => {
    const suggestions = suggestCommands(ACCOUNT_COMMAND_SPECS, ['account', 'lst'])
    expect(suggestions).toContain('account list')
    expect(suggestions).not.toContain('account rm')
    expect(suggestions).not.toContain('account remove')
  })

  it('rejects an unregistered account deletion verb', () => {
    expect(() =>
      validateCommandAndFlags(ACCOUNT_COMMAND_SPECS, {
        commandPath: ['account', 'delete'],
        flags: new Map()
      })
    ).toThrow('Unknown command: account delete')
  })
})
