import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as quality from './check-changed-code-quality.mjs'

const processCalls = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))
// oxlint-disable-next-line anti-slop/no-module-mocking -- Test-only external process boundary; actual main executes.
vi.mock('node:child_process', () => processCalls)
// oxlint-disable-next-line anti-slop/no-module-mocking -- Resolve only the external executable used by this fixture.
vi.mock('./oxlint-cli-invocation.mjs', () => ({
  resolveOxlintInvocation: () => ({ command: 'fixture-oxlint', prefixArgs: [] })
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const createMatcher = (blocks) =>
  quality.createMovedCodeMatcher?.(blocks) ?? ((lines) => quality.isMovedCode(lines, blocks))

describe('moved-code base normalization budget', () => {
  it('normalizes fixed base lines once across repeated changed-line diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-moved-code-budget-'))
    const file = join(root, 'fixture.mjs')
    const source = 'brandNewCall()\n'
    writeFileSync(file, source)
    const blocks = [Array.from({ length: 5000 }, (_, index) => `  base_line_${index}()  `)]
    const matcher = createMatcher(blocks)
    const ranges = new Map([['fixture.mjs', [{ start: 1, end: 1 }]]])
    const diagnostic = {
      filename: file,
      labels: [{ span: { line: 1, offset: 0, length: source.length - 1 } }]
    }
    const original = String.prototype.replace
    let normalizedBaseLines = 0
    const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (...args) {
      if (String(this).startsWith('  base_line_')) {
        normalizedBaseLines += 1
      }
      return original.apply(this, args)
    })
    try {
      const results = Array.from({ length: 100 }, () =>
        quality.diagnosticTouchesAddedLines(diagnostic, ranges, root, blocks, matcher)
      )
      spy.mockRestore()
      expect(results).toEqual(Array(100).fill(true))
      expect(normalizedBaseLines).toBe(5000)
    } finally {
      spy.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the existing exemption decisions across mixed repeated highlights', () => {
    const body = Array.from({ length: 20 }, (_, index) => `line${index}()`)
    const blocks = [['  a()  ', '', '\tb()'], body, ['first()', 'last()']]
    const matcher = createMatcher(blocks)
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
    for (let repeat = 0; repeat < 10; repeat += 1) {
      for (const { lines, moved } of observations) {
        expect(matcher(lines)).toBe(moved)
        expect(quality.isMovedCode(lines, blocks)).toBe(moved)
      }
    }
  })

  it('does not normalize unvisited blocks and recomputes for the next invocation', () => {
    const unused = ['  base_line_unused()  ']
    const blocks = [['first()'], unused]
    const matcher = createMatcher(blocks)
    const original = String.prototype.replace
    let unusedReads = 0
    const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (...args) {
      if (String(this).startsWith('  base_line_')) {
        unusedReads += 1
      }
      return original.apply(this, args)
    })
    try {
      expect(matcher([])).toBe(false)
      expect(matcher(['first()'])).toBe(true)
      expect(unusedReads).toBe(0)
    } finally {
      spy.mockRestore()
    }
    blocks[0][0] = 'changed()'
    const nextMatcher = createMatcher(blocks)
    expect(nextMatcher(['changed()'])).toBe(true)
    expect(nextMatcher(['first()'])).toBe(false)
    expect(quality.isMovedCode(['changed()'], blocks)).toBe(true)
  })

  it('shares the matcher across diagnostics and scans in the actual main entrypoint', () => {
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
      if (args.includes('--name-only')) {
        return 'fixture.mjs\0'
      }
      if (args.includes('--unified=0')) {
        return '@@ -0,0 +1 @@\n+brandNewCall()\n'
      }
      throw new Error(`Unexpected Git arguments: ${args.join(' ')}`)
    })
    const baseline = Array.from({ length: 1000 }, (_, index) => `base_line_${index}()`)
    const diagnostics = Array.from({ length: 10 }, () => ({
      filename: file,
      message: 'New code finding',
      labels: [{ span: { line: 1, offset: 0, length: 14 } }]
    }))
    processCalls.spawnSync.mockImplementation((command, args) => {
      if (command === 'git') {
        return { status: 0, stdout: args[0] === 'show' ? baseline.join('\n') : '' }
      }
      return { status: 1, stdout: JSON.stringify({ diagnostics }), stderr: '' }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const replace = String.prototype.replace
    let normalizedBaseLines = 0
    vi.spyOn(String.prototype, 'replace').mockImplementation(function (...args) {
      if (String(this).startsWith('base_line_')) {
        normalizedBaseLines += 1
      }
      return replace.apply(this, args)
    })
    try {
      expect(quality.main(root, 'baseline')).toBe(1)
      const scans = processCalls.spawnSync.mock.calls.filter(([command]) => command !== 'git')
      expect(scans).toHaveLength(quality.OXLINT_SCANS.length)
      expect(error.mock.calls.filter(([message]) => message.startsWith('::error '))).toHaveLength(
        diagnostics.length * quality.OXLINT_SCANS.length
      )
      expect(normalizedBaseLines).toBe(2000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
