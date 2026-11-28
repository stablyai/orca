import { describe, expect, it } from 'vitest'

import { findCommandSpec, isCommandGroup } from '../arguments/args'
import { COMMAND_SPECS } from '../specs'
import { formatGroupHelp } from './help'

describe('formatGroupHelp', () => {
  it('reaches every command, hidden ones included, from its group typed by name', () => {
    for (const spec of COMMAND_SPECS) {
      for (let depth = 1; depth < spec.path.length; depth++) {
        const group = spec.path.slice(0, depth)
        if (findCommandSpec(COMMAND_SPECS, group)) {
          continue
        }
        expect(isCommandGroup(COMMAND_SPECS, group), group.join(' ')).toBe(true)
      }
    }
    expect(formatGroupHelp(COMMAND_SPECS, ['bot', 'look-around'])).toContain('  set ')
    expect(formatGroupHelp(COMMAND_SPECS, ['bot'])).not.toContain('  look-around set ')
  })
})
