import { describe, expect, it } from 'vitest'
import {
  buildWindowsCmdShimCommandLine,
  isCmdInterpretedProgram,
  parseWindowsCommandLine,
  quoteWindowsArgument
} from './windows-command-line'
import { WINDOWS_ARGUMENT_CORPUS } from './__fixtures__/windows-argument-corpus'

/** cmd tracks quote state by counting `"`; an odd count leaks operators. */
function quoteParity(line: string): number {
  return (line.match(/"/g) ?? []).length % 2
}

describe('quoteWindowsArgument', () => {
  it.each(WINDOWS_ARGUMENT_CORPUS)(
    'round-trips $name through the command-line parser',
    ({ value }) => {
      expect(parseWindowsCommandLine(quoteWindowsArgument(value))).toEqual([value])
    }
  )

  it('round-trips the whole corpus as a single multi-argument line', () => {
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const line = values.map(quoteWindowsArgument).join(' ')
    expect(parseWindowsCommandLine(line)).toEqual(values)
  })

  it('writes an embedded quote as "" so cmd quote parity stays even', () => {
    // Why this exact assertion: `\"` also decodes to a literal quote, but it
    // leaves cmd one quote short, and every later `&`/`|` on the line then
    // parses as an operator instead of data.
    expect(quoteWindowsArgument('c"d')).toBe('"c""d"')
    expect(quoteParity(quoteWindowsArgument('c"d'))).toBe(0)
  })

  it('doubles a trailing backslash run so the closing quote survives', () => {
    expect(quoteWindowsArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
  })
})

describe('buildWindowsCmdShimCommandLine', () => {
  it('keeps cmd quote parity even for every corpus entry', () => {
    for (const { name, value } of WINDOWS_ARGUMENT_CORPUS) {
      const line = buildWindowsCmdShimCommandLine('C:\\bin\\agent.cmd', [value])
      expect(quoteParity(line), `${name} leaves cmd mid-quote`).toBe(0)
    }
  })

  it('breaks every percent out of the quoted run', () => {
    // `%VAR%` expands even inside quotes, so the pair must not survive intact.
    const line = buildWindowsCmdShimCommandLine('C:\\bin\\agent.cmd', ['e%F%g'])
    expect(line).toContain('"^%"')
    expect(line).not.toMatch(/%F%/)
  })

  it('pins the cmd flags that make the encoding safe', () => {
    const line = buildWindowsCmdShimCommandLine('C:\\bin\\agent.cmd', ['x'])
    // /d: no registry AutoRun. /v:off: `!` stays literal regardless of the
    // Command Processor default. /s: strip exactly the outer quote pair.
    expect(line.startsWith('/d /v:off /s /c "')).toBe(true)
    expect(line.endsWith('"')).toBe(true)
  })

  it('quotes a program path containing spaces', () => {
    const line = buildWindowsCmdShimCommandLine('C:\\Program Files\\a\\agent.cmd', [])
    expect(line).toContain('"C:\\Program Files\\a\\agent.cmd"')
  })
})

describe('isCmdInterpretedProgram', () => {
  it.each([
    ['C:\\bin\\agent.cmd', true],
    ['C:\\bin\\agent.CMD', true],
    ['C:\\bin\\agent.bat', true],
    ['C:\\bin\\agent.exe', false],
    ['C:\\bin\\agent', false],
    ['C:\\bin\\agent.ps1', false]
  ])('%s -> %s', (program, expected) => {
    expect(isCmdInterpretedProgram(program)).toBe(expected)
  })
})

describe('line breaks', () => {
  it.each([
    ['newline in an argument', 'agent', ['fix\nthis']],
    ['carriage return in an argument', 'agent', ['fix\rthis']],
    ['newline in the program path', 'C:\\a\nb.cmd', []]
  ])('rejects %s rather than truncating it', (_case, program, args) => {
    // cmd ends the command at a raw CR/LF whatever the quote state, so an
    // encoded newline silently truncates the argument and can leave the
    // remainder to run as a further command.
    expect(() => buildWindowsCmdShimCommandLine(program, args)).toThrow(/line break/)
  })
})
