import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from '../help'
import { CORE_COMMAND_SPECS } from './core'

function terminalSendSpec() {
  const spec = CORE_COMMAND_SPECS.find(
    (entry) => entry.path.length === 2 && entry.path[0] === 'terminal' && entry.path[1] === 'send'
  )
  if (!spec) {
    throw new Error('terminal send command spec missing')
  }
  return spec
}

describe('terminal send help (#14032)', () => {
  it('documents --text as a raw PTY byte channel with control-key examples', () => {
    const help = formatCommandHelp(terminalSendSpec())
    expect(help).toContain('Raw PTY bytes')
    expect(help).toContain("$'\\x1b'")
    expect(help).toMatch(/verbatim|raw/i)
    expect(help).toContain('Notes:')
    expect(help).toContain('Examples:')
  })
})
