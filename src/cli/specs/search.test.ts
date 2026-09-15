import { describe, expect, it } from 'vitest'
import { SEARCH_COMMAND_SPECS } from './search'
import { effectiveAllowedFlags, findCommandSpec, GLOBAL_FLAGS } from '../args'
import { buildAgentContext } from '../agent-context'
import { suggestCommands } from '../command-suggestion'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { formatCommandHelp, printHelp } from '../help'
import { ROOT_HELP_TEXT_PRIMARY } from '../root-help-text-primary'
import { ROOT_HELP_TEXT_SECONDARY } from '../root-help-text-secondary'
import { COMMAND_SPECS } from './index'
import { CLI_COMMAND_NAMES } from '../../main/startup/cli-command-names'

const searchSpec = SEARCH_COMMAND_SPECS[0]!
const help = formatCommandHelp(searchSpec)

describe('orca search command spec', () => {
  it('is one command, not a group, because the query is a bare positional', () => {
    expect(SEARCH_COMMAND_SPECS).toHaveLength(1)
    expect(searchSpec.path).toEqual(['search'])
    expect(searchSpec.positionalArgs).toEqual(['query'])
  })

  it('is registered in the live spec table, the dispatcher and the launch redirect', () => {
    expect(COMMAND_SPECS).toContain(searchSpec)
    expect(HANDLER_COMMAND_KEYS.has('search')).toBe(true)
    expect(CLI_COMMAND_NAMES).toContain('search')
  })

  it('accepts exactly the flags that map onto the search contract', () => {
    expect([...searchSpec.allowedFlags].sort()).toEqual([
      'agent',
      'cursor',
      'debug',
      'environment',
      'fresh',
      'help',
      'index-status',
      'json',
      'limit',
      'pairing-code',
      'path',
      'query',
      'scope',
      'since',
      'sort'
    ])
  })

  it('declares --agent and --path repeatable for this command only', () => {
    expect(searchSpec.repeatableFlags).toEqual(['agent', 'path'])
    for (const spec of COMMAND_SPECS) {
      if (spec !== searchSpec) {
        expect(spec.repeatableFlags).toBeUndefined()
      }
    }
  })

  it('does not accept or advertise browser page targeting', () => {
    expect(effectiveAllowedFlags(searchSpec)).not.toContain('page')
    expect(help).not.toContain('--page')
  })

  it('describes every search flag rather than falling back to the bare name', () => {
    const searchOnly = searchSpec.allowedFlags.filter((flag) => !GLOBAL_FLAGS.includes(flag))
    expect(searchOnly).toHaveLength(11)
    for (const flag of searchOnly) {
      expect(help).toContain(`--${flag}`)
      expect(help.split('\n')).not.toContain(`  --${flag}`)
    }
  })

  it('describes --agent as a search filter, not a terminal agent to launch', () => {
    expect(help).toContain('Restrict to one agent; repeat for several')
    expect(help).not.toContain('TUI agent')
  })

  it('tells the reader to quote a multi-word query', () => {
    expect(searchSpec.notes?.join('\n')).toContain('Quote a multi-word query')
  })

  it('states that it searches one host and offers no all-computers search', () => {
    expect(searchSpec.notes?.join('\n')).toContain('There is no all-computers search.')
  })

  it('shows both the query and the index report in its usage', () => {
    expect(searchSpec.usage).toContain('orca search <query>')
    expect(searchSpec.usage).toContain('orca search --index-status')
  })
})

describe('orca search discovery surfaces', () => {
  it('is hidden until the settings toggle ships', () => {
    expect(searchSpec.hidden).toBe(true)
  })

  it('is absent from the root help', () => {
    expect(ROOT_HELP_TEXT_PRIMARY).not.toContain('Agent Sessions:')
    expect(ROOT_HELP_TEXT_PRIMARY).not.toContain('  search  ')
    expect(ROOT_HELP_TEXT_SECONDARY).not.toContain('orca search')
  })

  it('still prints its own help for `orca search --help`', () => {
    const lines: string[] = []
    const restore = console.log
    console.log = (value: unknown) => void lines.push(String(value))
    try {
      printHelp(COMMAND_SPECS, ['search'])
    } finally {
      console.log = restore
    }
    expect(lines.join('\n')).toContain('Usage: orca search <query>')
  })

  it('still resolves for dispatch even though it is hidden', () => {
    expect(findCommandSpec(COMMAND_SPECS, ['search'])).toBe(searchSpec)
  })

  it('is withheld from agent discovery', () => {
    const command = buildAgentContext(COMMAND_SPECS).commands.find(
      (entry) => entry.command === 'search'
    )
    expect(command).toBeUndefined()
  })

  it('is not offered as a suggestion for an unknown command', () => {
    expect(suggestCommands(COMMAND_SPECS, ['serch'])).not.toContain('search')
  })
})
