import { describe, expect, it } from 'vitest'
import {
  buildWindowsCmdShimCommandLine,
  quoteWindowsArgument,
  quoteWindowsArgumentLikeLibuv,
  quoteWindowsCmdArgument
} from './windows-command-line'
import { WINDOWS_ARGUMENT_CORPUS } from './__fixtures__/windows-argument-corpus'

/** cmd tracks quote state by counting `"`; an odd count leaks operators. */
function quoteParity(line: string): number {
  return (line.match(/"/g) ?? []).length % 2
}

describe('quoteWindowsArgument', () => {
  it('writes an embedded quote as "" so cmd quote parity stays even', () => {
    expect(quoteWindowsArgument('c"d')).toBe('"c""d"')
    expect(quoteParity(quoteWindowsArgument('c"d'))).toBe(0)
  })

  it('doubles a trailing backslash run so the closing quote survives', () => {
    expect(quoteWindowsArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
  })
})

describe('quoteWindowsArgumentLikeLibuv', () => {
  // The expected outputs are the ones libuv's quote_cmd_arg documents.
  it.each([
    ['', '""'],
    ['hello', 'hello'],
    ['hello\\world', 'hello\\world'],
    ['hello world', '"hello world"'],
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'],
    ['C:\\Program Files\\x', '"C:\\Program Files\\x"']
  ])('quotes %j as %s', (value, expected) => {
    expect(quoteWindowsArgumentLikeLibuv(value)).toBe(expected)
  })
})

describe('buildWindowsCmdShimCommandLine', () => {
  it('keeps cmd quote parity even and leaves cmd only inert characters unquoted', () => {
    // One probe per character cmd acts on, wrapped in an even quote count like JSON.
    const probes = [...'&|<>^%!(),;= \t\u0085é'].map((char) => ({
      name: `probe ${JSON.stringify(char)}`,
      value: `{"k":"a${char}b"}`
    }))
    for (const { name, value } of [...WINDOWS_ARGUMENT_CORPUS, ...probes]) {
      const quoted = quoteWindowsCmdArgument(value)
      expect(quoteParity(quoted), `${name} leaves cmd mid-quote`).toBe(0)
      // Even split segments are what cmd reads unquoted; "^%" is the deliberate percent break-out.
      const unquoted = quoted
        .split('"')
        .filter((_, index) => index % 2 === 0)
        .join('')
        .replaceAll('^%', '')
      expect(unquoted, `${name} exposes cmd-active characters`).toMatch(
        /^[\w\\{}:.[\]/@#$*?~'`+-]*$/
      )
    }
  })

  it('spells cmd-inert quotes as \\" so CommandLineToArgvW shims keep the next flag separate', () => {
    // Bun <= 1.3 ends a quoted run at `""`, so this JSON swallowed `--setting-sources user`.
    const line = buildWindowsCmdShimCommandLine('C:\\bin\\claude.cmd', [
      '--settings',
      '{"disableAllHooks":true}',
      '--setting-sources',
      'user'
    ])
    expect(line).toBe(
      '/d /v:off /s /c ""C:\\bin\\claude.cmd" "--settings" "{\\"disableAllHooks\\":true}" "--setting-sources" "user""'
    )
  })

  it('breaks every percent out of the quoted run', () => {
    const line = buildWindowsCmdShimCommandLine('C:\\bin\\agent.cmd', ['e%F%g'])
    expect(line).toContain('"^%"')
    expect(line).not.toMatch(/%F%/)
  })

  it('pins the cmd flags that make the encoding safe', () => {
    const line = buildWindowsCmdShimCommandLine('C:\\bin\\agent.cmd', ['x'])
    expect(line.startsWith('/d /v:off /s /c "')).toBe(true)
    expect(line.endsWith('"')).toBe(true)
  })

  it('quotes a program path containing spaces', () => {
    const line = buildWindowsCmdShimCommandLine('C:\\Program Files\\a\\agent.cmd', [])
    expect(line).toContain('"C:\\Program Files\\a\\agent.cmd"')
  })
})

describe('line breaks', () => {
  it.each([
    ['newline in an argument', 'agent', ['fix\nthis']],
    ['carriage return in an argument', 'agent', ['fix\rthis']],
    ['newline in the program path', 'C:\\a\nb.cmd', []]
  ])('rejects %s rather than truncating it', (_case, program, args) => {
    // cmd terminates at raw CR/LF even inside quotes; the remainder could become another command.
    expect(() => buildWindowsCmdShimCommandLine(program, args)).toThrow(/line break/)
  })
})
