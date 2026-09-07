import { describe, expect, it } from 'vitest'

import { ACCOUNT_COMMAND_SPECS } from './account'
import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp } from '../help'

function spec(path: string): (typeof ACCOUNT_COMMAND_SPECS)[number] {
  const found = ACCOUNT_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing account spec: ${path}`)
  }
  return found
}

describe('account command specs', () => {
  it('does not accept or advertise browser page targeting', () => {
    for (const entry of ACCOUNT_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(entry)).not.toContain('page')
      expect(formatCommandHelp(entry)).not.toContain('--page')
    }
  })

  // Why: named for what it asserts — the rendered Options block, not the `usage`
  // string, which this test never reads.
  it('renders --json and --help in its Options block', () => {
    for (const entry of ACCOUNT_COMMAND_SPECS) {
      const help = formatCommandHelp(entry)
      expect(help).toContain('--json')
      expect(help).toContain('--help')
    }
  })

  it('describes --agent as the account provider, not a terminal agent', () => {
    const help = formatCommandHelp(spec('account add'))

    expect(help).toContain('Account provider: claude or codex (default claude)')
    expect(help).not.toContain('TUI agent')
  })

  it('aligns the --agent description with the global flag descriptions', () => {
    const descriptionColumn = (help: string, flag: string): number => {
      const line = help.split('\n').find((entry) => entry.startsWith(`  --${flag}`))
      const match = line?.match(/^(\s*--\S+(?: <[^>]+>)?)(\s+)\S/)
      if (!match) {
        throw new Error(`No description found for --${flag}`)
      }
      return match[1].length + match[2].length
    }
    const help = formatCommandHelp(spec('account add'))

    expect(descriptionColumn(help, 'agent')).toBe(descriptionColumn(help, 'json'))
  })
})
