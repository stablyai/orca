import { expect, it } from 'vitest'
import { parseArgs, REPEATED_FLAG_SEPARATOR, type CommandSpec } from './args'
import { COMMAND_SPECS } from './specs'

// A command other than `search` on purpose: the parser must read this vocabulary
// off the resolved spec, not off a command name written into the parser.
const DEMO: CommandSpec = {
  path: ['demo', 'run'],
  summary: 'demo',
  usage: 'demo run',
  allowedFlags: ['enable', 'agent', 'note'],
  booleanFlags: ['enable'],
  repeatableFlags: ['agent']
}

it('reads value-less and repeatable flags from the spec that owns them', () => {
  const parsed = parseArgs(
    ['demo', 'run', '--enable', '--agent', 'codex', '--agent', 'claude', '--note', 'hi'],
    [DEMO.path],
    [DEMO]
  )

  expect(parsed.commandPath).toEqual(['demo', 'run'])
  expect(parsed.flags.get('enable')).toBe(true)
  expect(parsed.flags.get('agent')).toBe(`codex${REPEATED_FLAG_SEPARATOR}claude`)
  expect(parsed.flags.get('note')).toBe('hi')
})

it('finds the command path behind a spec-declared boolean flag', () => {
  const parsed = parseArgs(['--enable', 'demo', 'run'], [DEMO.path], [DEMO])

  expect(parsed.commandPath).toEqual(['demo', 'run'])
  expect(parsed.flags.get('enable')).toBe(true)
})

it('does not leak one command vocabulary into another', () => {
  const parsed = parseArgs(
    ['worktree', 'create', '--agent', 'codex', '--agent', 'claude'],
    COMMAND_SPECS.flatMap((spec) => [spec.path]),
    COMMAND_SPECS
  )

  expect(parsed.flags.get('agent')).toBe('claude')
})

it('does not let a spec-declared boolean swallow the token after it', () => {
  const parsed = parseArgs(['demo', 'run', '--enable', 'oops'], [DEMO.path], [DEMO])

  expect(parsed.flags.get('enable')).toBe(true)
  expect(parsed.commandPath).toEqual(['demo', 'run', 'oops'])
})

// The boundary scan runs before the command is known, so it takes the union of
// every spec's value-less flags. That is only safe while no two specs disagree.
it('has no flag that one command treats as value-less and another as valued', () => {
  const valueless = new Set(COMMAND_SPECS.flatMap((spec) => spec.booleanFlags ?? []))
  const disagreements = COMMAND_SPECS.flatMap((spec) =>
    spec.allowedFlags
      .filter((flag) => valueless.has(flag) && !(spec.booleanFlags ?? []).includes(flag))
      .map((flag) => `${spec.path.join(' ')} --${flag}`)
  )

  expect(disagreements).toEqual([])
})
