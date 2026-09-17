import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// Only the pure functions are under test; the tsc spawn is proven end to end by CI.
import {
  diffBaseline,
  diffCensus,
  hasTsNocheckDirective,
  parseBaseline,
  parseFailingFiles,
  parseProgramTestFiles,
  TESTS_OUTSIDE_PROGRAM
} from './check-tests-typecheck-ratchet.mjs'

describe('the failing-file parser', () => {
  it('names each file once however many errors it carries', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2345: Argument of type x.',
      'src/a.test.ts(19,1): error TS2322: Type y.',
      'src/b.test.tsx(3,3): error TS18047: z is possibly null.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts', 'src/b.test.tsx'])
  })

  // tsc indents the "Overload 1 of 2, ..." detail under its error; counting those as files would
  // put unparseable entries in the baseline and make the gate unprunable.
  it('ignores the indented detail lines tsc prints under an error', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2769: No overload matches this call.',
      "  Overload 1 of 2, '(callback: () => Promise<void>): Promise<undefined>', gave the following error.",
      '    Type VitestUtils is missing the following properties.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts'])
  })

  // tsc prints the host separator. Left as-is, a Windows run would read every baseline entry as
  // both stale and added, and the gate would be unpassable rather than wrong in one direction.
  it("normalises the Windows separators tsc prints to the baseline's POSIX ones", () => {
    const output = [
      'src\\session\\a.test.ts(12,5): error TS2345: Argument of type x.',
      'scripts\\b.test.tsx(3,3): error TS18047: z is possibly null.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['scripts/b.test.tsx', 'src/session/a.test.ts'])
  })

  it('answers nothing for a clean run', () => {
    expect(parseFailingFiles('')).toEqual([])
  })
})

describe('the baseline diff', () => {
  it('drops comments and blanks when reading the baseline', () => {
    expect([...parseBaseline('# header\n\nsrc/a.test.ts\n  src/b.test.ts  \n')]).toEqual([
      'src/a.test.ts',
      'src/b.test.ts'
    ])
  })

  it('reports a newly failing file as added and a newly clean one as stale', () => {
    expect(
      diffBaseline(['src/a.test.ts', 'src/c.test.ts'], ['src/a.test.ts', 'src/b.test.ts'])
    ).toEqual({ added: ['src/c.test.ts'], stale: ['src/b.test.ts'] })
  })

  it('reports neither when the set is unchanged, which is the green path', () => {
    expect(diffBaseline(['src/a.test.ts'], ['src/a.test.ts'])).toEqual({ added: [], stale: [] })
  })
})

describe('the program census', () => {
  const allow = new Map([['src/node-side.test.ts', 'imports the desktop main process']])

  // The error diff sees a file only once it errors, so without this an excluded test is silent.
  it('names a test file that is on disk but outside the program', () => {
    expect(
      diffCensus(['src/a.test.ts', 'src/b.test.ts'], ['src/a.test.ts'], allow).missing
    ).toEqual(['src/b.test.ts'])
  })

  // A wildcard include keeps only the higher-priority extension, so a .tsx beside a .test.ts of the
  // same basename leaves the program with no config change at all. This is the case that hid
  // MobileHostCard.test.tsx.
  it('names a .tsx shadowed by a .test.ts of the same basename', () => {
    expect(
      diffCensus(['src/Card.test.ts', 'src/Card.test.tsx'], ['src/Card.test.ts'], new Map()).missing
    ).toEqual(['src/Card.test.tsx'])
  })

  it('stays quiet for a file excluded on purpose', () => {
    expect(diffCensus(['src/node-side.test.ts'], [], allow)).toEqual({
      missing: [],
      staleAllowance: []
    })
  })

  it('reports an allowance whose file is gone, so the list cannot rot', () => {
    expect(diffCensus([], [], allow).staleAllowance).toEqual(['src/node-side.test.ts'])
  })

  it('reports an allowance whose file is back in the program', () => {
    expect(
      diffCensus(['src/node-side.test.ts'], ['src/node-side.test.ts'], allow).staleAllowance
    ).toEqual(['src/node-side.test.ts'])
  })

  it('stays quiet when every file on disk is in the program', () => {
    expect(diffCensus(['src/a.test.ts'], ['src/a.test.ts'], new Map())).toEqual({
      missing: [],
      staleAllowance: []
    })
  })

  // The allow-list and the tsconfig exclude are two lists of the same four files; drift between
  // them would either break the build or re-open the hole silently.
  it('matches tsconfig.test.json exclude entry for entry', () => {
    const root = path.join(import.meta.dirname, '..')
    const config = fs.readFileSync(path.join(root, 'tsconfig.test.json'), 'utf8')
    const excluded = [...config.matchAll(/"([^"]+\.test\.tsx?)"/g)].map((match) => match[1])
    expect(excluded.sort()).toEqual([...TESTS_OUTSIDE_PROGRAM.keys()].sort())
    for (const entry of TESTS_OUTSIDE_PROGRAM.keys()) {
      expect(fs.existsSync(path.join(root, entry))).toBe(true)
    }
  })
})

// One `tsc --noEmit --listFiles` pass answers both questions, so both parsers read the same stream.
describe('the single-pass output split', () => {
  const output = [
    '/repo/mobile/node_modules/typescript/lib/lib.es2020.d.ts',
    '/repo/mobile/src/session/a.test.ts',
    '/repo/mobile/src/session/a.ts',
    '/repo/mobile/scripts/b.test.tsx',
    'src/session/a.test.ts(12,5): error TS2345: Argument of type x.',
    'scripts/b.test.tsx(3,3): error TS18047: z is possibly null.'
  ].join('\n')

  it('takes only the listed test paths as the program', () => {
    expect(parseProgramTestFiles(output, '/repo/mobile')).toEqual([
      'scripts/b.test.tsx',
      'src/session/a.test.ts'
    ])
  })

  it('takes only the diagnostics as the failures, from that same stream', () => {
    expect(parseFailingFiles(output)).toEqual(['scripts/b.test.tsx', 'src/session/a.test.ts'])
  })

  it('strips a Windows root the same way it strips the separators', () => {
    expect(parseProgramTestFiles('C:\\repo\\mobile\\src\\a.test.ts', 'C:\\repo\\mobile')).toEqual([
      'src/a.test.ts'
    ])
  })
})

// tsc exits 0 on a @ts-nocheck file, so without this a baselined test could be "fixed" with one
// line, pruned off the baseline, and never checked again.
describe('the @ts-nocheck guard', () => {
  it('sees the directive in a leading line comment', () => {
    expect(hasTsNocheckDirective('// @ts-nocheck\nimport { it } from "vitest"\n')).toBe(true)
  })

  it('sees it in a leading block comment', () => {
    expect(hasTsNocheckDirective('/**\n * @ts-nocheck\n */\nexport {}\n')).toBe(true)
  })

  // TypeScript only honours it before the first statement, so neither should this.
  it('ignores it once code has started', () => {
    expect(hasTsNocheckDirective('import { it } from "vitest"\n// @ts-nocheck\n')).toBe(false)
  })

  it('stays quiet for an ordinary header comment', () => {
    expect(hasTsNocheckDirective('// Tests the reply schema.\nexport {}\n')).toBe(false)
  })
})
