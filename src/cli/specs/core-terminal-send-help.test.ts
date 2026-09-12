import { describe, expect, it, vi } from 'vitest'
import { formatCommandHelp, printHelp } from '../help'
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

function expectBashZshAnsiCExamples(help: string): void {
  const ansiCQuoteLines = help.split('\n').filter((line) => line.includes("$'"))
  expect(ansiCQuoteLines.length).toBeGreaterThan(0)
  expect(ansiCQuoteLines.every((line) => line.includes('Bash/Zsh'))).toBe(true)
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

  it('labels every ANSI-C quoted control-byte example as Bash/Zsh', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(CORE_COMMAND_SPECS)
    const rootHelp = String(log.mock.calls[0]?.[0])
    log.mockRestore()

    expect(rootHelp).toContain('Raw bytes written to the PTY')
    expectBashZshAnsiCExamples(rootHelp)
    expectBashZshAnsiCExamples(formatCommandHelp(terminalSendSpec()))
  })
})
