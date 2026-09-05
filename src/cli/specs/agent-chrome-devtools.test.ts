import { describe, expect, it } from 'vitest'
import { AGENT_CHROME_DEVTOOLS_COMMAND_SPECS } from './agent-chrome-devtools'
import { formatCommandHelp } from '../help'
import { parseArgs, validateCommandAndFlags } from '../args'

describe('Chrome DevTools command help and parsing', () => {
  it('describes config targeting and preview without terminal launch semantics', () => {
    for (const spec of AGENT_CHROME_DEVTOOLS_COMMAND_SPECS) {
      expect(formatCommandHelp(spec)).toContain('Config target: codex, opencode, or all (required)')
      expect(formatCommandHelp(spec)).not.toContain('TUI agent')
    }
    expect(formatCommandHelp(AGENT_CHROME_DEVTOOLS_COMMAND_SPECS[0])).toContain(
      'Validate and preview without changing canonical config'
    )
  })
  it('parses dry-run before command segments without consuming the command', () => {
    const specs = AGENT_CHROME_DEVTOOLS_COMMAND_SPECS
    const parsed = parseArgs(
      ['--dry-run', 'agent', 'chrome-devtools', 'setup', '--agent', 'all'],
      specs.map((spec) => spec.path)
    )
    expect(parsed.commandPath).toEqual(['agent', 'chrome-devtools', 'setup'])
    expect(() => validateCommandAndFlags(specs, parsed)).not.toThrow()
  })
})
