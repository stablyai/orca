import { runProcessSync } from '@orca/process-host'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal'
import {
  diffBaseline,
  diffCensus,
  hasTsNocheckDirective,
  main,
  parseBaseline,
  parseFailingFiles,
  parseProgramTestFiles,
  TESTS_OUTSIDE_PROGRAM
} from './check-tests-typecheck-ratchet.mjs'

vi.mock('@orca/process-host', () => ({ runProcessSync: vi.fn() }))
vi.mock('./mobile-typecheck-compiler.mjs', () => ({
  resolveMobileTypecheckCommand: (project: string, cwd: string) => ({
    program: 'compiler',
    args: ['--project', project],
    cwd
  })
}))

describe('ratchet failure diagnostics', () => {
  it.each([
    { name: 'new failure', baseline: '', failed: true, exit: 1, printsDiagnostics: true },
    { name: 'clean pass', baseline: '', failed: false, exit: 0, printsDiagnostics: false },
    {
      name: 'grandfathered failure',
      baseline: 'src/value.test.ts\n',
      failed: true,
      exit: 0,
      printsDiagnostics: false
    },
    {
      name: 'stale baseline',
      baseline: 'src/value.test.ts\n',
      failed: false,
      exit: 1,
      printsDiagnostics: false
    }
  ])('preserves $name outcome and baseline', ({ baseline, failed, exit, printsDiagnostics }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pr31180-ratchet-'))
    const diagnostic = 'src/value.test.ts(1,2): error TS2322: Type number is not assignable.'
    const stderrDiagnostic = 'src/value.test.ts(2,3): error TS2345: Argument type mismatch.'
    const detail = '  Type number is not assignable to type string.'
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (const file of [...TESTS_OUTSIDE_PROGRAM.keys(), 'src/value.test.ts']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), 'export {}\n')
      }
      const baselineFile = path.join(root, 'tests-typecheck-baseline.txt')
      fs.writeFileSync(baselineFile, baseline)
      const programFile = path.join(fs.realpathSync(root), 'src/value.test.ts')
      vi.mocked(runProcessSync).mockReturnValue({
        code: failed ? 2 : 0,
        signal: null,
        timedOut: false,
        stdout: `${programFile}\n${failed ? `${diagnostic}\n${detail}\n` : ''}`,
        stderr: failed ? `${stderrDiagnostic}\n` : ''
      })

      expect(main(root)).toBe(exit)
      expect(runProcessSync).toHaveBeenCalledExactlyOnceWith({
        program: 'compiler',
        args: ['--project', 'tsconfig.test.json', '--listFiles'],
        cwd: root,
        timeoutMs: null,
        maxOutputBytes: 64 * 1024 * 1024
      })
      expect(errors.mock.calls.some(([message]) => message === diagnostic)).toBe(printsDiagnostics)
      expect(errors.mock.calls.some(([message]) => message === stderrDiagnostic)).toBe(
        printsDiagnostics
      )
      expect(
        errors.mock.calls.some(([message]) => message === detail || message === programFile)
      ).toBe(false)
      expect(fs.readFileSync(baselineFile, 'utf8')).toBe(baseline)
    } finally {
      vi.mocked(runProcessSync).mockReset()
      errors.mockRestore()
      logs.mockRestore()
      removeTreeSync(root)
    }
  })
})

describe('the failing-file parser', () => {
  it('names each file once however many errors it carries', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2345: Argument of type x.',
      'src/a.test.ts(19,1): error TS2322: Type y.',
      'src/b.test.tsx(3,3): error TS18047: z is possibly null.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts', 'src/b.test.tsx'])
  })

  // Indented overload details are not diagnostic files; counting them makes baseline unprunable.
  it('ignores the indented detail lines tsc prints under an error', () => {
    const output = [
      'src/a.test.ts(12,5): error TS2769: No overload matches this call.',
      "  Overload 1 of 2, '(callback: () => Promise<void>): Promise<undefined>', gave the following error.",
      '    Type VitestUtils is missing the following properties.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['src/a.test.ts'])
  })

  // Normalize Windows separators or every baseline entry appears stale and added.
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

  // Higher-priority .tsx can shadow same-stem .test.ts through wildcard include without config changes (MobileHostCard case).
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

  // Pin allowlist/tsconfig exclusion parity so neither silently widens the other.
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
