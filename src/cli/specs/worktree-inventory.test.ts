import { describe, expect, it } from 'vitest'
import { COMMAND_SPECS } from './index'
import { parseArgs, validateCommandAndFlags } from '../args'
import { formatCommandHelp } from '../help'

describe('worktree inventory public command', () => {
  it('is discoverable with explicit scope and completeness guidance', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'worktree inventory')!
    const help = formatCommandHelp(spec)
    for (const flag of ['repo', 'repo-path', 'project', 'host']) {
      expect(help).toContain(`--${flag}`)
    }
    expect(help).toContain('authoritative=true')
    expect(help).toContain('method_not_found')
  })

  it.each(['limit', 'cursor'])('rejects --%s before dispatch', (flag) => {
    const parsed = parseArgs(['worktree', 'inventory', `--${flag}`, '1'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow()
  })
})
