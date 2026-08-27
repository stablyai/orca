import { describe, expect, it } from 'vitest'
import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp } from '../help'
import { SKILL_COMMAND_SPECS } from './skills'

function spec(path: string): (typeof SKILL_COMMAND_SPECS)[number] {
  const found = SKILL_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing skill spec: ${path}`)
  }
  return found
}

describe('skill command specs', () => {
  it('requires explicit selectors for sharing and exposes no bulk or path flag', () => {
    const flags = effectiveAllowedFlags(spec('skills share'))

    expect(flags).toContain('skill')
    expect(flags).toContain('bundle-name')
    expect(flags).not.toContain('all')
    expect(flags).not.toContain('path')
    expect(formatCommandHelp(spec('skills share'))).toContain(
      'Only discovered skill directories can be selected'
    )
  })
})
