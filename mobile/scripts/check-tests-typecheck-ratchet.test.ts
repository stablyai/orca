import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal'
import {
  checkNodeTestProgram,
  findShadowedPhoneAliases,
  lintExternalBodies,
  parseCompilerPass,
  partitionNodeTestBodies,
  readNodeTestBodies
} from './check-node-tests-typecheck.mjs'
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
const external = [
  'src/main/codex/codex-form-transport-envelope.test.ts',
  'src/main/codex/codex-settled-body-contract-fixture.ts'
]
const none: string[] = []
const cleanTransfers = () => ({
  ok: true,
  expected: transfers,
  external: [...none],
  programTestFiles: transfers,
  programExternalFiles: [...none],
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

  it('fails a desktop body or helper missing from the program or opting out, without an RN exclusion', () => {
    expect(
      checkTransfers(
        { ...cleanTransfers(), external, programExternalFiles: [external[0]] },
        allowed,
        [external[0]]
      )
    ).toEqual([
      `checked desktop body opts out with @ts-nocheck: ${external[0]}`,
      `checked desktop body is absent from its program: ${external[1]}`
    ])
  })

  it('reads every body root from the config as a repository path on any platform', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pr36356-node-bodies-'))
    try {
      fs.mkdirSync(path.join(root, 'mobile'))
      fs.writeFileSync(
        path.join(root, 'mobile/tsconfig.test.node.json'),
        JSON.stringify({
          files: [
            'src/a.test.ts',
            '..\\src\\main\\b.test.ts',
            '../src/main/helper.ts',
            '../src/x.d.ts'
          ]
        })
      )
      const bodies = readNodeTestBodies(root)
      expect(bodies).toEqual(['mobile/src/a.test.ts', 'src/main/b.test.ts', 'src/main/helper.ts'])
      expect(partitionNodeTestBodies(bodies)).toEqual({
        local: ['src/a.test.ts'],
        external: ['src/main/b.test.ts', 'src/main/helper.ts']
      })
    } finally {
      removeTreeSync(root)
    }
  })

  it('names a phone declaration or phone test body whose @/ import a renderer file shadows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pr36356-shadowed-alias-'))
    const output = path.join(root, 'out')
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), text)
    }
    try {
      write('out/src/renderer/src/lib/x.d.ts', 'export {}')
      write('out/mobile/src/a.d.ts', "import '@/lib/x'\nimport '@/lib/phone-only'")
      write('mobile/src/b.test.ts', "import { y } from '@/lib/x'")
      expect(findShadowedPhoneAliases(output, ['mobile/src/b.test.ts'], root)).toEqual([
        'phone alias resolves to a renderer file: mobile/src/b.test.ts imports @/lib/x',
        'phone alias resolves to a renderer file: mobile/src/a.d.ts imports @/lib/x'
      ])
    } finally {
      removeTreeSync(root)
    }
  })

  // The desktop bodies' typed lint passes only when it read every body and found nothing.
  it.each([
    { name: 'clean', files: 2, diagnostics: [], code: 0, ok: true },
    { name: 'a body left unread', files: 1, diagnostics: [], code: 0, ok: false },
    { name: 'a finding', files: 2, diagnostics: [{ message: 'any union' }], code: 1, ok: false },
    { name: 'no bodies', files: 0, diagnostics: [], code: 0, ok: false, bodies: [] }
  ])('lints the contract bodies against their declarations: $name', (row) => {
    const bodies = row.bodies ?? external
    const run = vi.fn((_invocation: { args: string[] }) => ({
      code: row.code,
      stdout: JSON.stringify({ diagnostics: row.diagnostics, number_of_files: row.files }),
      stderr: ''
    }))
    expect(lintExternalBodies(bodies, path.resolve(import.meta.dirname, '../..'), run).ok).toBe(
      row.ok
    )
    expect(run.mock.calls[0]![0].args).toEqual(
      expect.arrayContaining([
        '--type-aware',
        '--tsconfig',
        'mobile/tsconfig.test.node.json',
        '--deny-warnings',
        ...bodies
      ])
    )
  })

  it('names a missing helper, leaked implementation source and native globals in the program', () => {
    expect(
      checkNodeTestProgram(
        [
          '/repo/mobile/src/a.test.ts',
          '/repo/src/main/b.test.ts',
          '/repo/src/shared/leak.ts',
          '/repo/node_modules/react-native/src/types/globals.d.ts'
        ],
        {
          realRoot: '/repo',
          expected: ['mobile/src/a.test.ts', 'src/main/b.test.ts', 'src/main/helper.ts']
        }
      )
    ).toEqual([
      'checked body is missing from the program: src/main/helper.ts',
      'implementation source re-entered the test program: src/shared/leak.ts',
      'native global declarations leaked into the test program: /repo/node_modules/react-native/src/types/globals.d.ts'
    ])
  })
})
