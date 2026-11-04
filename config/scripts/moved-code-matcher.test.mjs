import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as quality from './check-changed-code-quality.mjs'
import * as mobilePhase from './run-typecheck-projects-in-parallel.mjs'
import { createExistingTypeAssertionMatcher } from './existing-type-assertions.mjs'

const processCalls = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', () => processCalls)
vi.mock('./oxlint-cli-invocation.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOxlintInvocation: () => ({ command: 'fixture-oxlint', prefixArgs: [] })
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('moved-code matcher and changed-line gate', () => {
  it('keeps an existing cast exempt when a changed call reflows its line', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-reflowed-cast-'))
    const file = join(root, 'fixture.ts')
    const source = 'const label = "🙂";\nconnect(\n  pane as never,\n  bind(deps)\n)\n'
    writeFileSync(file, source)
    const existing = createExistingTypeAssertionMatcher([
      { file: 'fixture.ts', source: 'connect(pane as never, deps as never)\n' }
    ])
    const fragment = 'pane as never'
    const diagnostic = {
      filename: file,
      code: 'typescript(consistent-type-assertions)',
      labels: [
        {
          span: {
            line: 3,
            offset: Buffer.byteLength(source.split(fragment)[0]),
            length: fragment.length
          }
        }
      ]
    }
    try {
      expect(
        quality.diagnosticTouchesAddedLines(
          diagnostic,
          new Map([['fixture.ts', [{ start: 3, end: 3 }]]]),
          root,
          [],
          () => false,
          existing
        )
      ).toBe(false)
      const changed = source.replace(fragment, 'other as never')
      writeFileSync(file, changed)
      diagnostic.labels[0].span.length = 'other as never'.length
      expect(
        quality.diagnosticTouchesAddedLines(
          diagnostic,
          new Map([['fixture.ts', [{ start: 3, end: 3 }]]]),
          root,
          [],
          () => false,
          existing
        )
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires a complete existing assertion with unchanged operand, type and literal data', () => {
    const existing = createExistingTypeAssertionMatcher([
      {
        file: 'fixture.ts',
        source:
          'const x = value as Thing; const y = "a  b" as string; // fake as never\nconst z = "text as never"'
      }
    ])
    expect(existing('value\n as Thing')).toBe(true)
    for (const source of [
      'other as Thing',
      'value as Other',
      'fake as never',
      'text as never',
      '"a b" as string',
      'value as Thing | undefined'
    ]) {
      expect(existing(source)).toBe(false)
    }
  })

  it('does not exempt assertions recovered from malformed baseline source', () => {
    const existing = createExistingTypeAssertionMatcher([
      { file: 'fixture.ts', source: 'const broken = ; const x = value as Thing' }
    ])
    expect(existing('value as Thing')).toBe(false)
  })

  it('keeps exemption decisions across different highlights in one matcher', () => {
    const body = Array.from({ length: 20 }, (_, index) => `line${index}()`)
    const blocks = [['  a()  ', '', '\tb()'], body, ['first()', 'last()']]
    const matcher = quality.createMovedCodeMatcher(blocks)
    const observations = [
      { lines: ['a()', '  ', 'b()'], moved: true },
      { lines: ['', '  '], moved: false },
      { lines: ['brandNewCall()', 'a()'], moved: false },
      { lines: ['first()', 'brandNewCall()'], moved: false },
      { lines: [...body.slice(0, 19), 'newDep,', body[19]], moved: true },
      {
        lines: ['line0()', ...Array.from({ length: 18 }, (_, index) => `fresh${index}()`)],
        moved: false
      },
      { lines: ['b()', 'a()'], moved: false }
    ]
    for (const { lines, moved } of observations) {
      expect(matcher(lines)).toBe(moved)
    }
  })

  it('reads changed base blocks when creating the next matcher', () => {
    const blocks = [['first()']]
    const matcher = quality.createMovedCodeMatcher(blocks)
    expect(matcher([])).toBe(false)
    expect(matcher(['first()'])).toBe(true)
    blocks[0][0] = 'changed()'
    const nextMatcher = quality.createMovedCodeMatcher(blocks)
    expect(nextMatcher(['changed()'])).toBe(true)
    expect(nextMatcher(['first()'])).toBe(false)
  })

  it.each([
    [false, false],
    [true, true],
    [true, false]
  ])(
    'reports every configured scan with common moved filtering, opt-in=%s joined=%s',
    async (mobileHostDeclarations, hasJoined) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-moved-code-main-'))
      const config = JSON.parse(
        readFileSync(
          new URL('../tsconfig.test.mobile-project-controls.json', import.meta.url),
          'utf8'
        )
      )
      const joined = config.files
        .find((entry) => entry.endsWith('mobile-web-shell-project-controls.test.ts'))
        .slice(3)
      const files = hasJoined ? ['fixture.mjs', joined] : ['fixture.mjs']
      for (const entry of files) {
        mkdirSync(join(root, entry, '..'), { recursive: true })
        writeFileSync(join(root, entry), 'brandNewCall()\nexistingCall()\n')
      }
      mkdirSync(join(root, 'config'), { recursive: true })
      writeFileSync(join(root, mobilePhase.MOBILE_JOINED_PROJECT), JSON.stringify(config))
      vi.stubEnv('GITHUB_EVENT_NAME', '')
      processCalls.execFileSync.mockImplementation((_command, args) => {
        if (args[0] === 'rev-list') {
          return 'head parent\n'
        }
        if (args[0] === 'merge-base') {
          return 'baseline\n'
        }
        if (args[0] === 'ls-files') {
          return ''
        }
        if (args.includes('--name-status')) {
          return files.map((entry) => `M\0${entry}\0`).join('')
        }
        if (args.includes('--name-only')) {
          return `${files.join('\0')}\0`
        }
        if (args.includes('--unified=0')) {
          return '@@ -0,0 +1,2 @@\n+brandNewCall()\n+existingCall()\n'
        }
        throw new Error(`Unexpected Git arguments: ${args.join(' ')}`)
      })
      const baseline = ['existingCall()']
      const diagnostics = (paths) =>
        paths.flatMap((filename) => [
          {
            filename,
            message: 'New code finding',
            labels: [{ span: { line: 1, offset: 0, length: 14 } }]
          },
          {
            filename,
            message: 'Moved finding',
            labels: [{ span: { line: 2 } }]
          }
        ])
      processCalls.spawnSync.mockImplementation((command, args) => {
        if (command === 'git') {
          return { status: 0, stdout: args[0] === 'show' ? baseline.join('\n') : '' }
        }
        if (args[0] === 'scan') {
          return { status: 0, stdout: '', stderr: '' }
        }
        return {
          status: 1,
          stdout: JSON.stringify({
            diagnostics: diagnostics(files.filter((entry) => args.includes(entry)))
          }),
          stderr: ''
        }
      })
      const analyzer = vi.fn(async () => ({
        code: 1,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ diagnostics: diagnostics([joined]) }),
        stderr: ''
      }))
      vi.spyOn(mobilePhase, 'selectTypecheckCompiler').mockReturnValue({
        compiler: 'bun',
        bunExecutable: 'fixture-bun'
      })
      const phase = vi
        .spyOn(mobilePhase, 'runMobileHostTypecheck')
        .mockImplementation(async (options) => {
          await options.consumeDeclarations({
            signal: new AbortController().signal,
            runOwnedProcess: analyzer
          })
          return []
        })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        expect(await quality.main(root, 'baseline', { mobileHostDeclarations })).toBe(1)
        const scans = processCalls.spawnSync.mock.calls.filter(
          ([command, args]) => command !== 'git' && args[0] !== 'scan'
        )
        expect(scans).toHaveLength(quality.OXLINT_SCANS.length)
        for (const [, args] of scans) {
          expect(files.filter((entry) => args.includes(entry))).toEqual(
            hasJoined && args.includes('--type-aware') ? ['fixture.mjs'] : files
          )
        }
        expect(phase).toHaveBeenCalledTimes(hasJoined ? 1 : 0)
        expect(analyzer).toHaveBeenCalledTimes(hasJoined ? 1 : 0)
        if (hasJoined) {
          expect(files.filter((entry) => analyzer.mock.calls[0][0].args.includes(entry))).toEqual([
            joined
          ])
        }
        const annotations = error.mock.calls
          .map(([message]) => message)
          .filter((message) => message.startsWith('::error '))
        expect(annotations).toEqual(
          quality.OXLINT_SCANS.flatMap(() =>
            files.map((entry) => `::error file=${entry},line=1,title=oxlint::New code finding`)
          )
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

it('reports a new added-line finding from every configured scan in main', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-moved-code-main-'))
  const file = join(root, 'fixture.mjs')
  writeFileSync(file, 'brandNewCall()\n')
  vi.stubEnv('GITHUB_EVENT_NAME', '')
  processCalls.execFileSync.mockImplementation((_command, args) => {
    if (args[0] === 'rev-list') {
      return 'head parent\n'
    }
    if (args[0] === 'merge-base') {
      return 'baseline\n'
    }
    if (args[0] === 'ls-files') {
      return ''
    }
    if (args.includes('--name-status')) {
      return 'M\0fixture.mjs\0'
    }
    if (args.includes('--name-only')) {
      return 'fixture.mjs\0'
    }
    if (args.includes('--unified=0')) {
      return '@@ -0,0 +1 @@\n+brandNewCall()\n'
    }
    throw new Error(`Unexpected Git arguments: ${args.join(' ')}`)
  })
  const baseline = ['existingCall()']
  const diagnostics = [
    {
      filename: file,
      message: 'New code finding',
      labels: [{ span: { line: 1, offset: 0, length: 14 } }]
    }
  ]
  processCalls.spawnSync.mockImplementation((command, args) => {
    if (command === 'git') {
      return { status: 0, stdout: args[0] === 'show' ? baseline.join('\n') : '' }
    }
    if (args[0] === 'scan') {
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: JSON.stringify({ diagnostics }), stderr: '' }
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(await quality.main(root, 'baseline')).toBe(1)
    const scans = processCalls.spawnSync.mock.calls.filter(
      ([command, args]) => command !== 'git' && args[0] !== 'scan'
    )
    expect(scans).toHaveLength(quality.OXLINT_SCANS.length)
    const annotations = error.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith('::error '))
    expect(annotations).toEqual(
      Array(quality.OXLINT_SCANS.length).fill(
        '::error file=fixture.mjs,line=1,title=oxlint::New code finding'
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
