import { describe, expect, it } from 'vitest'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { unknownCommandData } from '../command-suggestion'
import { formatGroupHelp } from '../help'
import { COMMAND_SPECS } from './index'

// The wrong guesses agents made before finding the top-level browser commands.
describe('browser command discovery', () => {
  it('lists the top-level browser commands under orca browser --help', () => {
    const help = formatGroupHelp(COMMAND_SPECS, ['browser'])
    expect(help).toContain('identity get')
    expect(help).toContain('Top-level browser commands (run as `orca <command>`')
    expect(help).toMatch(/\n {2}tab create +Create a new browser tab/)
    expect(help).toMatch(/\n {2}goto +Navigate the active browser tab/)
    expect(help).toMatch(/\n {2}snapshot +/)
    expect(help).toMatch(/\n {2}screenshot +/)
  })

  it('keeps other group help free of browser commands', () => {
    expect(formatGroupHelp(COMMAND_SPECS, ['tab'])).not.toContain('Top-level')
    expect(formatGroupHelp(COMMAND_SPECS, ['worktree'])).not.toContain('Top-level')
  })

  it.each([
    [['browser', 'open', 'https://example.com'], ['tab create']],
    [['browser', 'goto', 'https://example.com'], ['goto']],
    [['browser', 'navigate', 'https://example.com'], ['goto']],
    [['browser', 'screenshot'], ['screenshot']],
    [['browser', 'snapshot'], ['snapshot']],
    [['browser', 'tab', 'create', 'https://example.com'], ['tab create']],
    [['navigate', 'https://example.com'], ['goto']],
    [['open', 'https://example.com'], ['tab create']]
  ])('recovers `orca %s` to the real command', (commandPath, expected) => {
    expect(unknownCommandData(COMMAND_SPECS, commandPath).suggestions).toEqual(expected)
  })

  it('points every unknown browser guess at the group help', () => {
    const { nextSteps } = unknownCommandData(COMMAND_SPECS, ['browser', 'zzzzzz'])
    expect(nextSteps).toEqual([
      "Orca's browser commands run at the top level (orca <command>, not orca browser <command>); list them with: orca browser --help"
    ])
  })

  it.each([
    ['identity', 'gett'],
    ['identit', 'get']
  ])('keeps browser %s %s recovery advice in the identity namespace', (namespace, verb) => {
    expect(unknownCommandData(COMMAND_SPECS, ['browser', namespace, verb])).toEqual({
      suggestions: ['browser identity get', 'browser identity set'],
      nextSteps: ['Did you mean: orca browser identity get, orca browser identity set']
    })
  })

  it('does not redirect an unknown identity command to top-level browser commands', () => {
    expect(unknownCommandData(COMMAND_SPECS, ['browser', 'identity', 'zzzzzz'])).toEqual({
      suggestions: [],
      nextSteps: []
    })
  })

  it('recovers a typo even when a URL follows it', () => {
    expect(
      unknownCommandData(COMMAND_SPECS, ['tab', 'creat', 'https://example.com']).suggestions
    ).toContain('tab create')
  })

  it.each([
    [['goto', 'https://example.com'], ['goto']],
    [
      ['tab', 'create', 'https://example.com'],
      ['tab', 'create']
    ]
  ])('accepts `orca %s` with the URL as a positional', (argv, path) => {
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
    expect(parsed.commandPath).toEqual(path)
    expect(parsed.flags.get('url')).toBe('https://example.com')
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('refuses a positional URL combined with --url', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['goto', 'https://a.example', '--url', 'https://b.example'])
    )
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow(
      'Pass --url either positionally or as a flag, not both.'
    )
  })
})
