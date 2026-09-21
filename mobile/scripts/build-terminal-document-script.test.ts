import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  emitTerminalDocumentModule,
  substituteDocumentConstants
} from './build-terminal-document-script.mjs'
import { terminalBackgroundFallback } from '../src/terminal/document/document-constants'

/**
 * What the generator drops, what it keeps, and how it puts a module back into the document.
 *
 * The per-group tests compare a real module against the string the document carries, which says
 * the two agree; these say why, on inputs small enough to read. The import and export cases are
 * the ones that bit: esbuild wraps a long list across lines, and skipping only the first line
 * leaves the rest of the names loose in the document.
 */
let directory: string

async function emit(source: string): Promise<string> {
  const path = join(directory, `module-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(path, source)
  return emitTerminalDocumentModule(path)
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-terminal-document-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('emitting one terminal document module', () => {
  it('unmarks an export and indents it into the document scope', async () => {
    expect(await emit('export function f() {\n  return 1\n}\n')).toBe(
      '  function f() {\n    return 1;\n  }'
    )
  })

  it('drops an import that fits on one line', async () => {
    expect(await emit("import { a } from './x'\nexport const b = 1\n")).toBe('  const b = 1;')
  })

  it('drops an import esbuild wrapped across lines', async () => {
    // The case that produced an unparseable document: the names after the first line stayed.
    const source =
      "import { alpha, beta, gamma, delta, epsilon, zeta, eta, theta } from './document-externals'\n" +
      'export const b = alpha\n'
    expect(await emit(source)).toBe('  const b = alpha;')
  })

  it('drops the trailing export block esbuild prints, not just its keyword', async () => {
    // Left behind it is a bare block statement, which parses and does nothing.
    const emitted = await emit('function f() {}\nfunction g() {}\nexport { f, g }\n')
    expect(emitted).not.toContain('{ f, g }')
    expect(emitted).toBe('  function f() {\n  }\n  function g() {\n  }')
  })

  it('erases types without touching the program', async () => {
    expect(
      await emit(
        'export type T = { a: number }\nexport function f(v: T): number {\n  return v.a\n}\n'
      )
    ).toBe('  function f(v) {\n    return v.a;\n  }')
  })

  it('substitutes a build-time constant the document carries as a literal', async () => {
    const emitted = await emit(
      "import { terminalBackgroundFallback } from '../src/terminal/document/document-constants'\n" +
        'export function paint() {\n' +
        '  return terminalBackgroundFallback\n' +
        '}\n'
    )
    expect(emitted).toContain(JSON.stringify(terminalBackgroundFallback))
    expect(emitted).not.toContain('terminalBackgroundFallback')
  })

  it('drops a lint directive rather than let it parenthesise the expression it guards', async () => {
    expect(
      await emit(
        'export const R =\n' + '  // oxlint-disable-next-line no-useless-escape\n' + '  /a/g\n'
      )
    ).toBe('  const R = /a/g;')
  })
})

describe('substituting a build-time constant', () => {
  it('writes a value containing a replacement pattern out as it stands', () => {
    // `$&` is the matched text to `String.replaceAll`'s string form, which would splice the
    // constant's own name in here and ship a document that says something else.
    const literal = JSON.stringify('a $& b')
    expect(substituteDocumentConstants('const v = marker;', { marker: literal })).toBe(
      'const v = "a $& b";'
    )
  })

  // `$n` is not listed: the pattern has no capture group, so it is already literal under either
  // form and a case for it could not tell them apart.
  it.each([['$&'], ["$'"], ['$`']])('is not read as the replacement pattern %s', (pattern) => {
    const literal = JSON.stringify(`x${pattern}y`)
    expect(substituteDocumentConstants('marker', { marker: literal })).toBe(literal)
  })
})
