import { describe, expect, it, vi } from 'vitest'

import { parseCompilerPass } from './check-node-tests-typecheck.mjs'
import {
  checkTransfers,
  hasTsNocheckDirective,
  parseFailingFiles,
  parseProgramTestFiles
} from './check-tests-typecheck-ratchet.mjs'

vi.mock('@orca/process-host', () => ({ runProcessSync: vi.fn() }))
vi.mock('./mobile-typecheck-compiler.mjs', () => ({
  resolveMobileTypecheckCommand: (project: string, cwd: string) => ({
    program: 'compiler',
    args: ['--project', project],
    cwd
  })
}))

const transfers = [
  'src/components/pr-sidebar/reviewer-picker.target-contract.test.tsx',
  'src/test-support/rpc-recording/recorded-request-params.test.ts'
]
const cleanTransfers = () => ({
  ok: true,
  expected: transfers,
  programTestFiles: transfers,
  failures: [],
  problems: []
})

describe('the failing-file parser', () => {
  // Normalize Windows separators or every baseline entry appears stale and added.
  it("normalises the Windows separators tsc prints to the baseline's POSIX ones", () => {
    const output = [
      'src\\session\\a.test.ts(12,5): error TS2345: Argument of type x.',
      'scripts\\b.test.tsx(3,3): error TS18047: z is possibly null.'
    ].join('\n')
    expect(parseFailingFiles(output)).toEqual(['scripts/b.test.tsx', 'src/session/a.test.ts'])
  })
})

// One `tsc --noEmit --listFiles` pass answers both questions, so both parsers read the same stream.
describe('the single-pass output split', () => {
  it('strips a Windows root the same way it strips the separators', () => {
    expect(parseProgramTestFiles('C:\\repo\\mobile\\src\\a.test.ts', 'C:\\repo\\mobile')).toEqual([
      'src/a.test.ts'
    ])
  })
})

// tsc exits 0 on a @ts-nocheck file, so without this a baselined test could be "fixed" with one
// line, pruned off the baseline, and never checked again.
describe('the @ts-nocheck guard', () => {
  // TypeScript only honours it before the first statement, so neither should this.
  it('ignores it once code has started', () => {
    expect(hasTsNocheckDirective('import { it } from "vitest"\n// @ts-nocheck\n')).toBe(false)
  })
})

describe('checked transfers', () => {
  it('accepts an empty checked cohort while retaining legacy runtime allowances', () => {
    expect(
      checkTransfers(
        { ok: true, expected: [], programTestFiles: [], failures: [], problems: [] },
        new Map([['legacy.test.ts', 'Legacy runtime-only: no checked transfer']])
      )
    ).toEqual([])
  })

  it('rejects a declared checked transfer missing from the configured roots', () => {
    expect(
      checkTransfers(
        { ok: true, expected: [], programTestFiles: [], failures: [], problems: [] },
        new Map([['checked.test.ts', 'Checked transfer: strict Node program']])
      )
    ).toEqual(['checked transfer is absent from tsconfig.test.node.json: checked.test.ts'])
  })
  const allowed = new Map(transfers.map((file) => [file, 'checked transfer']))

  it('never reads a failed declaration producer or final compiler as clean output', () => {
    expect(parseCompilerPass('/repo/mobile/src/a.test.ts\n', 2).ok).toBe(false)
    expect(
      parseCompilerPass('/repo/mobile/src/a.test.ts\nsrc/a.test.ts(1,1): error TS2322: x\n', 0).ok
    ).toBe(false)
    expect(checkTransfers({ ...cleanTransfers(), ok: false }, allowed)).toEqual([
      'the phone/host contract program did not pass'
    ])
  })
})
